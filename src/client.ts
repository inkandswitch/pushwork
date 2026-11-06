import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
	busyFile,
	COMMANDS,
	daemonVersion,
	HELLO_MS,
	logFile,
	pidFile,
	privateDir,
	probe,
	sleep,
	socketPath,
	type Busy,
	type Call,
	type Command,
	type Probe,
	type Status,
} from "./daemon.js";
import { log } from "./log.js";
import type * as pushwork from "./pushwork.js";
import type { RpcPeer } from "./rpc.js";

const dlog = log("client");

/** The commands, as the CLI calls them: here, or in the daemon. */
export type Api = Pick<typeof pushwork, Command>;

const START_MS = 10_000;
// how long `daemon stop` gives a daemon with no command in flight to go before terminating it
const STOP_MS = 60_000;
// a command that has run this long is taken for a hung daemon, not a busy one
const STUCK_MS = 10 * 60_000;
// how long a command waits for the daemon before saying so
const SLOW_MS = 1000;

/** Where a client says what it's waiting for: the CLI's output. */
export type Say = (message: string) => void;

// each thing said once
function once(say: Say): Say {
	const said = new Set<string>();
	return message => {
		if (said.has(message)) return;
		said.add(message);
		say(message);
	};
}

const alive = (pid: number) => {
	try {
		return pid > 0 && process.kill(pid, 0);
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) return false;
		await sleep(50);
	}
	return true;
}

// whether anything still listens on the socket
const listening = (sock: string) =>
	new Promise<boolean>(resolve => {
		const socket = net.connect(sock);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});

async function readPid(): Promise<number> {
	return Number(await fs.promises.readFile(pidFile(), "utf8").catch(() => "")) || 0;
}

async function readBusy(): Promise<Busy | undefined> {
	try {
		const busy = JSON.parse(await fs.promises.readFile(busyFile(), "utf8"));
		if (typeof busy?.pid === "number" && Array.isArray(busy.calls)) return busy as Busy;
	} catch {}
	return undefined;
}

/**
 * The command the daemon `pid` is busy with, from daemon.busy, if it's one to wait for: a
 * command's Automerge work can keep the daemon from answering for a long time, and terminating
 * it would kill that command, the user's, in another terminal. Undefined if the daemon may be
 * terminated: the busy file isn't `pid`'s, `pid` isn't alive, nothing is in flight, or the
 * oldest command has run for over `stuckMs`.
 */
export function busyWith(busy: Busy | undefined, pid: number, alive: boolean, now: number, stuckMs = STUCK_MS): Call | undefined {
	if (!busy || pid <= 0 || busy.pid !== pid || !alive || busy.calls.length === 0) return undefined;
	const oldest = busy.calls.reduce((a, b) => (b.since < a.since ? b : a));
	return now - oldest.since > stuckMs ? undefined : oldest;
}

const busyCall = async (pid: number, stuckMs?: number) => busyWith(await readBusy(), pid, alive(pid), Date.now(), stuckMs);
const busyMessage = (call: Call) => `waiting for the pushwork daemon (busy with ${call.fn} in ${call.cwd})`;

// Ask a daemon that stopped answering to finish up and go (it drains on SIGTERM as on stop); kill it if it won't.
async function terminate(pid: number): Promise<void> {
	if (!alive(pid)) return;
	dlog("terminating daemon pid %d", pid);
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
	if (await until(() => !alive(pid), 2000)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
	await until(() => !alive(pid), 5000);
}

/**
 * Hello to this home's daemon. Only through a socket directory that's the user's own and
 * private: whoever could put a socket there would run our commands. One belonging to someone
 * else throws; a loose one counts as no daemon, so a new one is started, which tightens it and
 * replaces the socket. Silent only after three tries over about six seconds: a busy daemon
 * isn't a hung one.
 */
export async function reachable(sock = socketPath()): Promise<Probe> {
	for (let tries = 1; ; tries++) {
		if ((await privateDir(path.dirname(sock))) !== "private") return { state: "down" };
		const start = Date.now();
		const p = await probe(sock);
		if (p.state !== "silent" || tries === 3) return p;
		await sleep(Math.max(0, HELLO_MS - (Date.now() - start)));
	}
}

// reachable(), for as long as the daemon is silent but busy with a command (see busyWith).
// Silent only for one that may be terminated.
async function patiently(sock: string, say: Say): Promise<Probe> {
	for (;;) {
		const p = await reachable(sock);
		if (p.state !== "silent") return p;
		const call = await busyCall(await readPid());
		if (!call) return p;
		say(busyMessage(call));
	}
}

// Wait for the daemon `pid`, asked to stop, to let go of the socket: for as long as it's
// running a command (see busyWith), and `ms` more once it isn't. False if it's still there.
// One that has exited is gone, though the socket may be a new daemon's by then.
async function gone(sock: string, pid: number, ms: number, say: Say): Promise<boolean> {
	let end = Date.now() + ms;
	while (alive(pid) && (await listening(sock))) {
		const call = await busyCall(pid);
		if (call) {
			say(busyMessage(call));
			end = Date.now() + ms;
		} else if (Date.now() > end) return false;
		await sleep(200);
	}
	return true;
}

function start(): ChildProcess {
	const home = os.homedir();
	fs.mkdirSync(path.dirname(logFile(home)), { recursive: true });
	// appended to: the daemon that wins the lock empties it
	const out = fs.openSync(logFile(home), "a");
	try {
		const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), "daemon", "run"], {
			detached: true,
			stdio: ["ignore", out, out],
			windowsHide: true,
			// not the caller's directory, which it would keep from being deleted on Windows
			cwd: path.parse(home).root,
		});
		child.on("error", e => dlog("starting the daemon: %s", e.message));
		child.unref();
		return child;
	} finally {
		fs.closeSync(out);
	}
}

// A connection to an up-to-date daemon: started if there's none, restarted if it's a
// different build, waited for while it's busy, terminated first if it doesn't answer and isn't.
async function reach(say: Say): Promise<RpcPeer> {
	const want = daemonVersion();
	const sock = socketPath();
	const first = await patiently(sock, say);
	if (first.state === "up") {
		if (first.hello.version === want && !first.hello.stopping) return first.peer;
		dlog("daemon %s is %s; replacing it", first.hello.version, first.hello.stopping ? "stopping" : "out of date");
		await first.peer.call("stop", []).catch(() => {});
		first.peer.close();
		await gone(sock, first.hello.pid, START_MS, say);
	} else if (first.state === "silent") {
		await terminate(await readPid());
	}
	// a daemon on its way out holds the lock the new one waits for, maybe after it has let go of
	// the socket: the new one's time starts once it has gone
	let old = first.state === "up" ? first.hello.pid : await readPid();
	let child = start();
	const cap = Date.now() + STOP_MS;
	let end = Date.now() + START_MS;
	let restarts = 0;
	for (;;) {
		await sleep(50);
		if ((await privateDir(path.dirname(sock))) === "private") {
			const p = await probe(sock);
			if (p.state === "up") {
				// any build will do now: one started at the same time by another build's command
				// would only be replaced again
				if (!p.hello.stopping) return p.peer;
				p.peer.close();
				old = p.hello.pid;
			}
			// The one this started has gone, and none took its place: stopped (by another process
			// opening the store, say) before this one could use it. Not forever: one that can't
			// start at all goes too.
			const exited = child.exitCode !== null || child.signalCode !== null;
			if (p.state === "down" && exited && restarts < 3) {
				dlog("the daemon went before answering; starting another");
				restarts++;
				child = start();
				end = Math.min(cap, Date.now() + START_MS);
			}
		}
		if (Date.now() < cap && alive(old)) end = Date.now() + START_MS;
		if (Date.now() > end) throw new Error(`the pushwork daemon didn't answer within ${START_MS} ms`);
	}
}

let session: RpcPeer | undefined;

/**
 * The commands, run in this home's daemon. Throws if it can't be reached or started. `say`
 * hears what it's waiting for, if it waits: a daemon starting, or busy with another command.
 */
export async function remote({ say = () => {} }: { say?: Say } = {}): Promise<Api> {
	const tell = once(say);
	const slow = setTimeout(() => tell("waiting for the pushwork daemon…"), SLOW_MS);
	let peer: RpcPeer;
	try {
		peer = await reach(tell);
	} finally {
		clearTimeout(slow);
	}
	session = peer;
	let closed = false;
	peer.onClose(() => (closed = true));
	const call =
		(fn: Command) =>
		async (...args: unknown[]) => {
			try {
				return await peer.call("call", [fn, args, process.cwd()]);
			} catch (e) {
				throw closed ? new Error("the pushwork daemon stopped while running this command") : e;
			}
		};
	return Object.fromEntries(COMMANDS.map(fn => [fn, call(fn)])) as unknown as Api;
}

/** Close the connection remote() made, so nothing keeps this process alive. */
export function hangUp(): void {
	session?.close();
	session = undefined;
}

/**
 * Stop this home's daemon, after the commands it's running finish, however long they take
 * (see busyWith); false if none was running. `say` hears what it's waiting for.
 */
export async function stopDaemon({ say = () => {} }: { say?: Say } = {}): Promise<boolean> {
	const tell = once(say);
	const sock = socketPath();
	const p = await patiently(sock, tell);
	if (p.state === "down") return false;
	if (p.state === "silent") {
		await terminate(await readPid());
		return true;
	}
	const { pid } = p.hello;
	await p.peer.call("stop", []).catch(() => {});
	p.peer.close();
	if (!(await gone(sock, pid, STOP_MS, tell))) await terminate(pid);
	// gone from the socket; wait for it to let go of its files too
	await until(() => !alive(pid), 5000);
	return true;
}

const left = new Map<string, Promise<void>>();

/**
 * Stop this home's daemon, if it's running, once per process: before this process opens the
 * machine's store with a node of its own, which the daemon's node would never see. One whose
 * socket can't be trusted can't be stopped either, and is left be.
 */
export function leaveDaemon(say?: Say): Promise<void> {
	const home = os.homedir();
	let leaving = left.get(home);
	if (!leaving) {
		leaving = stopDaemon({ say }).then(
			() => {},
			e => dlog("stopping the daemon: %s", e instanceof Error ? e.message : e),
		);
		left.set(home, leaving);
	}
	return leaving;
}

/** The daemon: its status if it answers, else what it's busy with, if anything; undefined if none is running. */
export type DaemonState =
	| { state: "up"; status: Status }
	| { state: "busy"; pid: number; call: Call }
	| { state: "silent"; pid: number };

export async function daemonStatus(): Promise<DaemonState | undefined> {
	const p = await reachable();
	if (p.state === "down") return undefined;
	if (p.state === "silent") {
		const pid = await readPid();
		// however long it's been at it
		const call = await busyCall(pid, Infinity);
		return call ? { state: "busy", pid, call } : { state: "silent", pid };
	}
	try {
		return { state: "up", status: (await p.peer.call("status", [])) as Status };
	} finally {
		p.peer.close();
	}
}
