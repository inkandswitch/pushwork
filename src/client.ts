import { spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
	COMMANDS,
	daemonVersion,
	logFile,
	pidFile,
	probe,
	sleep,
	socketPath,
	type Command,
	type Status,
} from "./daemon.js";
import { log } from "./log.js";
import type * as pushwork from "./pushwork.js";
import type { RpcPeer } from "./rpc.js";

const dlog = log("client");

/** The commands, as the CLI calls them: here, or in the daemon. */
export type Api = Pick<typeof pushwork, Command>;

const START_MS = 10_000;
// how long `daemon stop` lets running commands finish before killing the daemon
const STOP_MS = 60_000;

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

async function kill(pid: number): Promise<void> {
	if (!alive(pid)) return;
	dlog("killing daemon pid %d", pid);
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
	await until(() => !alive(pid), 5000);
}

function start(): void {
	const home = os.homedir();
	fs.mkdirSync(path.dirname(logFile(home)), { recursive: true });
	// emptied, then appended to, so a daemon still on its way out doesn't write into a hole
	fs.writeFileSync(logFile(home), "");
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
	} finally {
		fs.closeSync(out);
	}
}

// A connection to an up-to-date daemon: started if there's none, restarted if it's a
// different build, killed first if it doesn't answer.
async function reach(): Promise<RpcPeer> {
	const want = daemonVersion();
	const sock = socketPath();
	const first = await probe(sock);
	if (first.state === "up") {
		if (first.hello.version === want && !first.hello.stopping) return first.peer;
		dlog("daemon %s is %s; replacing it", first.hello.version, first.hello.stopping ? "stopping" : "out of date");
		await first.peer.call("stop", []).catch(() => {});
		first.peer.close();
		await until(async () => !(await listening(sock)), START_MS);
	} else if (first.state === "hung") {
		await kill(await readPid());
	}
	start();
	const end = Date.now() + START_MS;
	for (;;) {
		await sleep(50);
		const p = await probe(sock);
		if (p.state === "up") {
			// any build will do now: one started at the same time by another build's command
			// would only be replaced again
			if (!p.hello.stopping) return p.peer;
			p.peer.close();
		}
		if (Date.now() > end) throw new Error(`the pushwork daemon didn't answer within ${START_MS} ms`);
	}
}

let session: RpcPeer | undefined;

/** The commands, run in this home's daemon. Throws if it can't be reached or started. */
export async function remote(): Promise<Api> {
	const peer = await reach();
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

/** Stop this home's daemon, after the commands it's running finish; false if none was running. */
export async function stopDaemon(): Promise<boolean> {
	const sock = socketPath();
	const p = await probe(sock);
	if (p.state === "down") return false;
	if (p.state === "hung") {
		await kill(await readPid());
		return true;
	}
	const { pid } = p.hello;
	await p.peer.call("stop", []).catch(() => {});
	p.peer.close();
	if (!(await until(async () => !(await listening(sock)), STOP_MS))) await kill(pid);
	// gone from the socket; wait for it to let go of its files too
	await until(() => !alive(pid), 5000);
	return true;
}

/** The running daemon's state, or undefined if none answers. */
export async function daemonStatus(): Promise<Status | undefined> {
	const p = await probe();
	if (p.state !== "up") return undefined;
	try {
		return (await p.peer.call("status", [])) as Status;
	} finally {
		p.peer.close();
	}
}
