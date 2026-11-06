import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { storeDir } from "./config.js";
import { Hub, currentHub, setHub } from "./hub.js";
import { loadSeed, signerFrom } from "./key.js";
import { lock } from "./lock.js";
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
// how long a new daemon waits for the lock while the daemon holding it is on its way out
const CLAIM_MS = 20_000;
// how long a stopping daemon waits for connected clients that aren't running a command to hang up
const GRACE_MS = 10_000;

const daemonDir = (home: string) => path.join(home, ".pushwork");
export const pidFile = (home = os.homedir()) => path.join(daemonDir(home), "daemon.pid");
export const logFile = (home = os.homedir()) => path.join(daemonDir(home), "daemon.log");

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

/**
 * The lock only one daemon per home holds, for its whole life: only the holder removes the
 * socket and listens. Undefined if another daemon is serving. One on its way out is waited
 * for; a lock whose holder is alive but has had no socket for CLAIM_MS (its pid reused by
 * another process after a crash, say) is taken over.
 */
async function claimLock(home: string): Promise<(() => Promise<void>) | undefined> {
	const file = path.join(daemonDir(home), "daemon");
	const deadline = Date.now() + CLAIM_MS;
	for (;;) {
		try {
			return await lock(file);
		} catch (e) {
			// lock() says "in use" with a plain Error; anything with a code is a real failure
			if ((e as NodeJS.ErrnoException).code) throw e;
		}
		const other = await probe(socketPath(home));
		if (other.state === "up") {
			other.peer.close();
			if (!other.hello.stopping) return undefined;
		}
		if (Date.now() > deadline) {
			if (other.state !== "down") return undefined;
			log(`taking over ${file}.lock, whose holder isn't serving`);
			await fsp.rm(`${file}.lock`, { force: true });
			continue;
		}
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
	// clients open the log to append, so only the daemon that won the lock starts it afresh
	await fsp.truncate(logFile(home), 0).catch(() => {});

	const version = daemonVersion();
	const startedAt = Date.now();
	const peers = new Set<RpcPeer>();
	let stopping = false;
	let inFlight = 0;
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

	async function run(fn: unknown, args: unknown, cwd: unknown): Promise<unknown> {
		if (typeof fn !== "string" || !(COMMANDS as readonly string[]).includes(fn)) {
			throw new Error(`unknown command ${String(fn)}`);
		}
		if (!Array.isArray(args)) throw new Error(`bad arguments for ${fn}`);
		const command = pushwork[fn as Command] as (...args: unknown[]) => Promise<unknown>;
		const start = Date.now();
		const go = () => callerCwd.run(typeof cwd === "string" ? cwd : undefined, () => command(...args));
		try {
			const result = await (fn === "migrate" ? exclusive(go) : shared(go));
			log(`${fn} in ${cwd}: ${Date.now() - start} ms`);
			return result;
		} catch (e) {
			log(`${fn} in ${cwd} failed after ${Date.now() - start} ms: ${errorText(e)}`);
			throw e;
		}
	}

	async function handle(method: string, args: unknown[]): Promise<unknown> {
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
				return run(args[0], args[1], args[2]);
		}
		throw new Error(`unknown method ${method}`);
	}

	const server = net.createServer(socket => {
		const peer = new RpcPeer(socket, handle);
		peers.add(peer);
		peer.onClose(() => peers.delete(peer));
	});
	await listen(server, sock);
	await fsp.writeFile(pidFile(home), String(process.pid));
	log(`pushwork daemon ${version} (pid ${process.pid}) listening on ${sock}`);

	const ownCwd = process.cwd.bind(process);
	process.cwd = () => callerCwd.getStore() ?? ownCwd();
	process.on("unhandledRejection", e => log(`unhandled rejection: ${errorText(e)}`));
	// what a client sends one that stopped answering: finish what it's running, as for stop
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));

	const homeCheck = setInterval(() => {
		if (!fs.existsSync(dir)) void shutdown(`${dir} is gone`);
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
		server.close();
		for (const peer of peers) peer.close();
		await closeHub();
		await fsp.rm(pidFile(home), { force: true });
		log("stopped");
		finish();
	}

	await finished;
}
