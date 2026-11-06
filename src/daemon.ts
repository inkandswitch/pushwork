import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { daemonPidFile, storeDir } from "./config.js";
import { Hub, currentHub, markDaemon, setHub } from "./hub.js";
import { loadSeed, signerFrom } from "./key.js";
import { lock, lockHolder } from "./lock.js";
import * as pushwork from "./pushwork.js";
import { RpcPeer } from "./rpc.js";
import { FsStorage } from "./storage.js";
import { versions } from "./version.js";

/**
 * What a client may run in the daemon: the commands src/cli.ts calls, and nothing else
 * from ./pushwork.js.
 */
export const COMMANDS = [
	"addContact",
	"addPublicApp",
	"checkAccess",
	"clone",
	"cutWorkdir",
	"diff",
	"heads",
	"init",
	"keyhiveInfo",
	"listContacts",
	"listPublicApps",
	"listShapes",
	"merge",
	"migrate",
	"newPublicApp",
	"pasteSnarf",
	"removeContact",
	"removePublicApp",
	"removeShape",
	"repoAccess",
	"save",
	"setContactAccess",
	"setKeyhiveServer",
	"setPublicAccess",
	"shapeInstall",
	"showSnarfs",
	"status",
	"sync",
	"track",
	"url",
	"yeet",
	"yoink",
] as const satisfies readonly (keyof typeof pushwork)[];

export type Command = (typeof COMMANDS)[number];

export const HELLO_MS = 2000;
const IDLE_MS = 10 * 60_000;
const HOME_CHECK_MS = 30_000;
// how long a holder of the daemon lock may go without a socket before it's taken over: less
// than a client waits for a daemon to start, so the command that started this one gets it
const CLAIM_MS = 8000;
// how long a new daemon waits for one on its way out to let go of the lock
const WAIT_MS = 60_000;
// how long a stopping daemon waits for connected clients that aren't running a command to hang up
const GRACE_MS = 10_000;

const daemonDir = (home: string) => path.join(home, ".pushwork");
export const pidFile = daemonPidFile;
export const logFile = (home = os.homedir()) => path.join(daemonDir(home), "daemon.log");
/** What the daemon is running (see Busy). */
export const busyFile = (home = os.homedir()) => path.join(daemonDir(home), "daemon.busy");

const hash = (home: string) => createHash("sha256").update(home).digest("hex").slice(0, 12);

/**
 * Where the daemon for `home` listens: a socket in .pushwork/run, a directory only its owner
 * can use, unless that path is too long for a socket.
 */
export function socketPath(home = os.homedir()): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\pushwork-${hash(home)}`;
	const sock = path.join(daemonDir(home), "run", "daemon.sock");
	if (Buffer.byteLength(sock) <= 100) return sock;
	return path.join("/tmp", `pushwork-${process.getuid!()}`, `${hash(home)}.sock`);
}

/** This build: a rebuilt daemon module makes the running daemon out of date. */
export function daemonVersion(): string {
	return `${versions.pushwork}+${fs.statSync(__filename).mtimeMs}`;
}

/**
 * Whoever can connect to the socket runs commands as this user, so the directory it's in must
 * be this user's own, and private. Throws if it belongs to someone else. With `fix`, it's made,
 * or tightened, if need be; without, says whether it's missing, private or loose.
 */
export async function privateDir(dir: string, { fix = false } = {}): Promise<"missing" | "private" | "loose"> {
	if (process.platform === "win32") return "private";
	if (fix) await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
	const st = await fsp.lstat(dir).catch(e => {
		if (e.code === "ENOENT") return undefined;
		throw e;
	});
	if (!st) return "missing";
	if (!st.isDirectory()) throw new Error(`${dir} isn't a directory`);
	if (st.uid !== process.getuid!()) throw new Error(`${dir} belongs to someone else`);
	if ((st.mode & 0o077) === 0) return "private";
	if (!fix) return "loose";
	await fsp.chmod(dir, 0o700);
	return "private";
}

export type Hello = { version: string; pid: number; stopping: boolean };
/** A command the daemon is running: its name, the caller's directory, and when it came in. */
export type Call = { fn: string; cwd: string; since: number };
/**
 * The commands in flight, which the daemon writes to daemon.busy as each starts and ends, so a
 * client can tell a daemon that's busy (a command's Automerge work can keep it from answering
 * for a long time) from one that's hung, even while it can't answer.
 */
export type Busy = { pid: number; calls: Call[] };
export type Status = { pid: number; version: string; startedAt: number; servers: { server: string; peer: string }[] };
/** up: it answered; down: nothing listens; silent: something took the connection but didn't answer. */
export type Probe = { state: "up"; peer: RpcPeer; hello: Hello } | { state: "silent" } | { state: "down" };

const TIMEOUT = Symbol("timeout");
const within = <T>(p: Promise<T>, ms: number) =>
	new Promise<T | typeof TIMEOUT>(resolve => {
		const timer = setTimeout(() => resolve(TIMEOUT), Math.max(ms, 0));
		p.then(v => {
			clearTimeout(timer);
			resolve(v);
		});
	});

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Say hello to the daemon at `sock`, within HELLO_MS. */
export async function probe(sock = socketPath()): Promise<Probe> {
	if (process.platform !== "win32") {
		const st = await fsp.lstat(sock).catch(() => undefined);
		if (!st) return { state: "down" };
		// whoever made the socket would get our commands
		if (st.uid !== process.getuid!()) throw new Error(`${sock} belongs to someone else`);
	}
	const deadline = Date.now() + HELLO_MS;
	const socket = net.connect(sock);
	const connected = await within(
		new Promise<NodeJS.ErrnoException | true>(resolve => {
			socket.once("connect", () => resolve(true));
			socket.once("error", resolve);
		}),
		HELLO_MS,
	);
	if (connected !== true) {
		socket.destroy();
		// only these say nobody is there: anything else may be a daemon too busy to answer
		const gone = connected !== TIMEOUT && (connected.code === "ECONNREFUSED" || connected.code === "ENOENT");
		return { state: gone ? "down" : "silent" };
	}
	const peer = new RpcPeer(socket);
	const hello = await within(
		peer.call("hello", []).then(
			h => h as Hello,
			() => undefined,
		),
		deadline - Date.now(),
	);
	if (hello === TIMEOUT || hello === undefined) {
		peer.close();
		return { state: "silent" };
	}
	return { state: "up", peer, hello };
}

// commands run with the caller's working directory: path.resolve and the like read it from process.cwd()
const callerCwd = new AsyncLocalStorage<string | undefined>();

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const lockBase = (home: string) => path.join(daemonDir(home), "daemon");

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/**
 * A command's arguments, with each of the caller's functions (report, warn, onStrategyDoc...)
 * throwing once `gone` says the caller has hung up (Ctrl-C, say). Commands report at every
 * step, so a cancelled one stops at its next, and doesn't go on to publish what the user
 * cancelled; its finally blocks let go of the checkout's lock.
 */
function cancellable(v: unknown, gone: () => boolean): unknown {
	if (typeof v === "function") {
		return (...args: unknown[]) => {
			if (gone()) throw new Error("the command was cancelled");
			return v(...args);
		};
	}
	if (Array.isArray(v)) return v.map(x => cancellable(x, gone));
	if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, cancellable(x, gone)]));
	if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cancellable(x, gone)]));
	return v;
}

/**
 * The lock only one daemon per home holds, for its whole life: only the holder removes the
 * socket and listens. Undefined if another daemon is serving, or if one on its way out takes
 * longer than WAIT_MS to go. A holder that's alive but has had no socket for CLAIM_MS (its pid
 * reused by another process after a crash, say, or stuck) is taken over: through lock(), so
 * the lock is removed only if it still names that holder, and only by one daemon at a time.
 */
async function claimLock(home: string): Promise<(() => Promise<void>) | undefined> {
	const file = lockBase(home);
	const end = Date.now() + WAIT_MS;
	// the holder being waited on, and since when it's had no socket
	let holder = 0;
	let since = Date.now();
	for (;;) {
		try {
			return await lock(file, { staleIf: Date.now() - since > CLAIM_MS ? holder : undefined });
		} catch (e) {
			// lock() says "in use" with a plain Error; anything with a code is a real failure
			if ((e as NodeJS.ErrnoException).code) throw e;
		}
		const now = await lockHolder(file);
		if (now !== holder) {
			holder = now;
			since = Date.now();
		}
		const other = await probe(socketPath(home));
		if (other.state === "up") {
			other.peer.close();
			if (!other.hello.stopping) return undefined;
		}
		if (other.state !== "down") since = Date.now();
		else if (Date.now() - since > CLAIM_MS) log(`taking over ${file}.lock from pid ${holder}, which has no socket`);
		if (Date.now() > end) return undefined;
		await sleep(200);
	}
}

// Listen on sock, which this daemon's lock makes its own.
async function listen(server: net.Server, sock: string): Promise<void> {
	if (process.platform !== "win32") await fsp.rm(sock, { force: true });
	// a named pipe outlives its daemon by a moment
	for (let tries = 0; ; tries++) {
		const err = await new Promise<NodeJS.ErrnoException | undefined>(resolve => {
			const failed = (e: NodeJS.ErrnoException) => resolve(e);
			server.once("error", failed);
			server.listen(sock, () => {
				server.off("error", failed);
				resolve(undefined);
			});
		});
		if (!err) break;
		if (err.code !== "EADDRINUSE" || tries >= 50) throw err;
		await sleep(100);
	}
	if (process.platform !== "win32") await fsp.chmod(sock, 0o600);
}

/**
 * Serve commands for this home on its socket until asked to stop, idle for ten minutes, or
 * the home's .pushwork is deleted. Every plain repo's documents go through one hub, so its
 * node is the only one writing the store while the daemon runs.
 */
export async function runDaemon(): Promise<void> {
	const home = os.homedir();
	const dir = daemonDir(home);
	await fsp.mkdir(dir, { recursive: true });
	const sock = socketPath(home);
	await privateDir(path.dirname(sock), { fix: true });
	const unlock = await claimLock(home);
	if (!unlock) {
		log("another daemon is serving this home");
		return;
	}
	try {
		await serve(home, sock);
	} finally {
		await unlock();
	}
}

async function serve(home: string, sock: string): Promise<void> {
	const dir = daemonDir(home);
	markDaemon();
	// clients open the log to append, so only the daemon that won the lock starts it afresh,
	// keeping the last one's beside it. Copied and emptied, not renamed: this daemon's output
	// is the log file it was started with.
	await fsp
		.copyFile(logFile(home), `${logFile(home)}.1`)
		.then(() => fsp.truncate(logFile(home), 0))
		.catch(() => {});

	const version = daemonVersion();
	const startedAt = Date.now();
	const peers = new Set<RpcPeer>();
	let stopping = false;
	let inFlight = 0;
	const calls = new Set<Call>();
	const drained: (() => void)[] = [];
	let idleTimer: NodeJS.Timeout | undefined;
	// set while a migrate runs: other commands wait for it
	let barrier: Promise<void> | undefined;
	let opening: Promise<void> | undefined;
	let finish!: () => void;
	const finished = new Promise<void>(resolve => (finish = resolve));

	const idle = () => (inFlight === 0 ? Promise.resolve() : new Promise<void>(resolve => drained.push(resolve)));
	const armIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => void shutdown("idle"), IDLE_MS);
	};

	async function track<T>(f: () => Promise<T>): Promise<T> {
		inFlight++;
		clearTimeout(idleTimer);
		try {
			return await f();
		} finally {
			if (--inFlight === 0) {
				for (const resolve of drained.splice(0)) resolve();
				if (!stopping) armIdle();
			}
		}
	}

	// opened on first use, so a store that can't be opened fails a command, not the daemon
	async function openHub(): Promise<void> {
		if (currentHub()) return;
		opening ??= (async () => {
			setHub(Hub.open(await FsStorage.open(storeDir()), signerFrom(await loadSeed())));
		})().finally(() => (opening = undefined));
		await opening;
	}

	async function closeHub(): Promise<void> {
		const hub = currentHub();
		setHub(undefined);
		await hub?.close().catch(e => log(`closing the hub: ${errorText(e)}`));
	}

	async function shared<T>(f: () => Promise<T>): Promise<T> {
		while (barrier) await barrier;
		return track(async () => {
			await openHub();
			return f();
		});
	}

	// migrate writes the store directly, which the hub's node would never see: it runs alone,
	// and the hub is replaced after it
	async function exclusive<T>(f: () => Promise<T>): Promise<T> {
		while (barrier) await barrier;
		let release!: () => void;
		barrier = new Promise(resolve => (release = resolve));
		try {
			await idle();
			return await track(async () => {
				await openHub();
				try {
					return await f();
				} finally {
					await closeHub();
					await openHub().catch(e => log(`reopening the hub: ${errorText(e)}`));
				}
			});
		} finally {
			barrier = undefined;
			release();
		}
	}

	// Written aside and renamed in, and synchronously, so it's on disk before a command's work
	// can keep this process from doing anything else.
	function writeBusy(): void {
		const tmp = `${busyFile(home)}.${process.pid}`;
		try {
			fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, calls: [...calls] } satisfies Busy));
			fs.renameSync(tmp, busyFile(home));
		} catch (e) {
			log(`writing ${busyFile(home)}: ${errorText(e)}`);
		}
	}

	async function run(caller: RpcPeer, fn: unknown, args: unknown, cwd: unknown): Promise<unknown> {
		if (typeof fn !== "string" || !(COMMANDS as readonly string[]).includes(fn)) {
			throw new Error(`unknown command ${String(fn)}`);
		}
		if (!Array.isArray(args)) throw new Error(`bad arguments for ${fn}`);
		const command = pushwork[fn as Command] as (...args: unknown[]) => Promise<unknown>;
		const start = Date.now();
		const guarded = cancellable(args, () => caller.isClosed) as unknown[];
		const go = () => callerCwd.run(typeof cwd === "string" ? cwd : undefined, () => command(...guarded));
		const call = { fn, cwd: String(cwd), since: start };
		calls.add(call);
		writeBusy();
		try {
			const result = await (fn === "migrate" ? exclusive(go) : shared(go));
			log(`${fn} in ${cwd}: ${Date.now() - start} ms`);
			return result;
		} catch (e) {
			log(`${fn} in ${cwd} failed after ${Date.now() - start} ms: ${errorText(e)}`);
			throw e;
		} finally {
			calls.delete(call);
			writeBusy();
		}
	}

	async function handle(caller: RpcPeer, method: string, args: unknown[]): Promise<unknown> {
		switch (method) {
			case "hello":
				return { version, pid: process.pid, stopping } satisfies Hello;
			case "status":
				return {
					pid: process.pid,
					version,
					startedAt,
					servers: (await currentHub()?.servers()) ?? [],
				} satisfies Status;
			case "stop":
				setImmediate(() => void shutdown("asked to stop"));
				return true;
			case "call":
				return run(caller, args[0], args[1], args[2]);
		}
		throw new Error(`unknown method ${method}`);
	}

	const server = net.createServer(socket => {
		const peer: RpcPeer = new RpcPeer(socket, (method, args) => handle(peer, method, args));
		peers.add(peer);
		peer.onClose(() => peers.delete(peer));
	});
	await listen(server, sock);
	await fsp.writeFile(pidFile(home), String(process.pid));
	log(`pushwork daemon ${version} (pid ${process.pid}) listening on ${sock}`);

	const ownCwd = process.cwd.bind(process);
	process.cwd = () => callerCwd.getStore() ?? ownCwd();
	process.on("unhandledRejection", e => log(`unhandled rejection: ${errorText(e)}`));
	// Node prints it too, but without saying when
	process.on("uncaughtExceptionMonitor", e => log(`uncaught exception: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
	// what a client sends one that stopped answering: finish what it's running, as for stop
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));

	// a daemon whose lock another took over (see claimLock) isn't reachable any more
	const displaced = async () => {
		const holder = await lockHolder(lockBase(home));
		return holder !== 0 && holder !== process.pid;
	};
	const homeCheck = setInterval(async () => {
		if (!fs.existsSync(dir)) void shutdown(`${dir} is gone`);
		else if (await displaced()) void shutdown("another daemon took over the lock");
	}, HOME_CHECK_MS);
	armIdle();

	async function shutdown(why: string): Promise<void> {
		if (stopping) return;
		stopping = true;
		log(`stopping: ${why}`);
		clearInterval(homeCheck);
		clearTimeout(idleTimer);
		// still listening, so no new daemon starts on the store before this one lets go of it; a
		// client that said hello before the stop may not have sent its command yet
		for (const end = Date.now() + GRACE_MS; inFlight > 0 || (peers.size > 0 && Date.now() < end); ) {
			await sleep(50);
		}
		// closing a unix socket's server unlinks its path, which after a takeover is the new daemon's
		// socket; exiting leaves it be
		if (await displaced()) log("not closing the socket, which is another daemon's now");
		else server.close();
		for (const peer of peers) peer.close();
		await closeHub();
		for (const file of [pidFile(home), busyFile(home)]) {
			if ((await ownerOf(file)) === process.pid) await fsp.rm(file, { force: true });
		}
		log("stopped");
		finish();
	}

	await finished;
}

// the daemon a file of its own names: the pid file is its pid, the busy file a Busy
async function ownerOf(file: string): Promise<number> {
	const text = (await fsp.readFile(file, "utf8").catch(() => "")).trim();
	if (/^\d+$/.test(text)) return Number(text);
	try {
		return Number((JSON.parse(text) as Busy).pid) || 0;
	} catch {
		return 0;
	}
}
