// Commands run in a daemon per home, which keeps its server connections open between them.
import { execFile, spawn } from "child_process";
import * as fs from "fs/promises";
import * as net from "net";
import * as path from "path";
import * as tmp from "tmp";
import { promisify } from "util";
import { RpcPeer } from "../../src/rpc";
import { socketPath } from "../../src/daemon";
import { save } from "../../src/pushwork";
import { exists, pushwork, readText, stopDaemons } from "../cli";
import { homeEnv, setHome } from "../home";
import { startServer } from "../server";

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist");
const CLI = path.join(DIST, "cli.js");
const SLAY = path.join(__dirname, "..", "..", "examples", "shapes", "slay.js");
// nothing listens here, so a migrate that reached for the server would fail
const UNREACHABLE = "ws://127.0.0.1:1";

const alive = (pid: number) => {
	try {
		return process.kill(pid, 0);
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return true;
		await new Promise(r => setTimeout(r, 100));
	}
	return check();
}

describe("daemon", () => {
	let work: string;
	let cleanup: () => void;
	let home: string;
	let env: NodeJS.ProcessEnv;
	let repo: string;
	let server: Awaited<ReturnType<typeof startServer>>;

	beforeEach(async () => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		work = t.name;
		cleanup = t.removeCallback;
		home = path.join(work, "home");
		repo = path.join(work, "repo");
		await fs.mkdir(home);
		await fs.mkdir(repo);
		await fs.writeFile(path.join(repo, "notes.txt"), "one\n");
		env = homeEnv(home);
		server = await startServer();
	});

	afterEach(async () => {
		await stopDaemons();
		await server.close();
		cleanup();
	});

	const run = (args: string[], cwd = repo) => pushwork(args, cwd, env);
	const pidFile = () => path.join(home, ".pushwork", "daemon.pid");
	const daemonPid = async () => Number(await readText(pidFile()));

	// a command in a terminal of its own, still running: its output so far, and how it exited
	const start = (args: string[], cwd = repo) => {
		const child = spawn(process.execPath, [CLI, ...args], {
			cwd,
			env: { ...process.env, ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
		});
		let output = "";
		child.stdout.on("data", d => (output += d));
		child.stderr.on("data", d => (output += d));
		const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
		return { child, output: () => output, exited };
	};

	// A sync in flight against a server that stopped answering, in a daemon that's stopped too:
	// what a long command does to the daemon's loop (Automerge's work on a big tree, say), as a
	// stopped process takes connections and answers none. Returns the sync, and the resume.
	async function busyDaemon() {
		await run(["init", "--sync-server", server.url]);
		const pid = await daemonPid();
		await fs.writeFile(path.join(repo, "notes.txt"), "two\n");
		server.stall();
		const sync = start(["sync"]);
		const busy = path.join(home, ".pushwork", "daemon.busy");
		await until(async () => (await readText(busy).catch(() => "")).includes('"sync"'), 5000);
		process.kill(pid, "SIGSTOP");
		let stopped = true;
		const resume = () => {
			if (stopped && alive(pid)) process.kill(pid, "SIGCONT");
			stopped = false;
		};
		return { pid, sync, resume };
	}

	const unix = process.platform !== "win32";

	it("two syncs share one connection", async () => {
		await run(["init", "--sync-server", server.url]);
		await fs.writeFile(path.join(repo, "notes.txt"), "two\n");
		await run(["sync"]);
		await fs.writeFile(path.join(repo, "notes.txt"), "three\n");
		await run(["sync"]);
		expect(server.connections()).toBe(1);
	});

	it("daemon status reports a running daemon", async () => {
		await run(["init", "--offline"]);
		const pid = await daemonPid();
		expect(alive(pid)).toBe(true);
		expect((await run(["daemon", "status"])).stdout).toContain(String(pid));
	});

	it.skipIf(!unix)("a command in another terminal waits for a busy daemon, whose command survives", { timeout: 120_000 }, async () => {
		const other = path.join(work, "other");
		await fs.mkdir(other);
		await fs.writeFile(path.join(other, "notes.txt"), "other\n");
		await run(["init", "--offline"], other);
		const { pid, sync, resume } = await busyDaemon();
		const where = await fs.realpath(repo);
		try {
			const status = start(["status"], other);
			const daemonStatus = start(["daemon", "status"]);
			expect(await until(() => status.output().includes(`waiting for the pushwork daemon (busy with sync in ${where})`), 30_000)).toBe(true);
			expect(alive(pid)).toBe(true);
			expect(await daemonStatus.exited).toBe(0);
			expect(daemonStatus.output()).toContain(`busy with sync in ${where}`);
			resume();
			expect(await status.exited).toBe(0);
		} finally {
			resume();
		}
		expect(await sync.exited).toBe(0);
		expect(sync.output()).not.toContain("stopped while running");
		expect(await daemonPid()).toBe(pid);
		expect(alive(pid)).toBe(true);
	});

	it.skipIf(!unix)("daemon stop waits for a busy daemon's command", { timeout: 120_000 }, async () => {
		const { pid, sync, resume } = await busyDaemon();
		try {
			const stop = start(["daemon", "stop"]);
			expect(await until(() => stop.output().includes("busy with sync in"), 30_000)).toBe(true);
			expect(alive(pid)).toBe(true);
			resume();
			expect(await stop.exited).toBe(0);
		} finally {
			resume();
		}
		expect(await sync.exited).toBe(0);
		expect(sync.output()).not.toContain("stopped while running");
		expect(alive(pid)).toBe(false);
	});

	it.skipIf(!unix)("daemon status says when the daemon doesn't answer", async () => {
		await run(["init", "--offline"]);
		const pid = await daemonPid();
		process.kill(pid, "SIGSTOP");
		try {
			expect((await run(["daemon", "status"])).stdout).toContain(`not answering (pid ${pid})`);
		} finally {
			process.kill(pid, "SIGCONT");
		}
	});

	it("a command whose caller is gone stops at its next step", async () => {
		// a daemon already running, so the init below gets to the server straight away
		const other = path.join(work, "other");
		await fs.mkdir(other);
		await run(["init", "--offline"], other);
		server.stall();
		const init = start(["init", "--sync-server", server.url]);
		// connecting: the server takes the connection and never answers
		expect(await until(() => server.connections() > 0, 15_000)).toBe(true);
		// what Ctrl-C does to the CLI
		init.child.kill("SIGKILL");
		await init.exited;
		// after 10 seconds the daemon gives up on the server, and would go on to publish offline
		const log = path.join(home, ".pushwork", "daemon.log");
		// by its name: on Windows the caller's directory may be spelled another way (8.3 short names)
		const ended = new RegExp(`init in .*\\b${path.basename(repo)}(: | failed)`);
		expect(await until(async () => ended.test(await readText(log)), 30_000)).toBe(true);
		for (const file of ["config.json", "heads.json", "checkout.lock"]) {
			expect(await exists(path.join(repo, ".pushwork", file))).toBe(false);
		}
		expect(await readText(log)).toContain("the command was cancelled");
	});

	it("a save through the library beside the daemon is published by the next sync", async () => {
		await run(["init", "--sync-server", server.url]);
		const url = (await run(["url"])).stdout.trim();
		await fs.writeFile(path.join(repo, "notes.txt"), "two\n");
		await run(["sync"]);
		await fs.writeFile(path.join(repo, "notes.txt"), "three\n");
		const restoreHome = setHome(home);
		try {
			await save(repo);
		} finally {
			restoreHome();
		}
		await run(["sync"]);
		const h2 = path.join(work, "h2");
		await fs.mkdir(h2);
		const copy = path.join(work, "copy");
		await pushwork(["clone", "--sync-server", server.url, url, copy], work, homeEnv(h2));
		expect(await readText(path.join(copy, "notes.txt"))).toBe("three\n");
	});

	it("keeps the last daemon's log as daemon.log.1", async () => {
		await run(["init", "--offline"]);
		const pid = await daemonPid();
		await run(["daemon", "stop"]);
		await run(["status"]);
		const log = path.join(home, ".pushwork", "daemon.log");
		expect(await readText(`${log}.1`)).toContain(`(pid ${pid}) listening`);
		expect(await readText(log)).not.toContain(`(pid ${pid})`);
		expect(await readText(log)).toContain(`(pid ${await daemonPid()}) listening`);
	});

	it("logs the error that kills it", async () => {
		await run(["init", "--offline"]);
		const pid = await daemonPid();
		// a shape module runs in the daemon, and can throw where nothing catches it
		const boom = path.join(work, "boom.js");
		await fs.writeFile(boom, 'setTimeout(() => { throw new Error("boom from a shape"); }); export default {};\n');
		// not a shape, or, if the throw comes first, the daemon stopped
		await expect(run(["shape", "install", "--name", "boom", boom])).rejects.toThrow(/not a shape|daemon stopped/);
		expect(await until(() => !alive(pid), 10_000)).toBe(true);
		expect(await readText(path.join(home, ".pushwork", "daemon.log"))).toMatch(/^\d{4}-\S+ uncaught exception: Error: boom from a shape$/m);
	});

	it("waits for a daemon on its way out before giving up on the next", async () => {
		// what a daemon finishing its stop holds for a moment: its lock and pid file, and no socket
		const old = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
		await new Promise(resolve => old.once("spawn", resolve));
		try {
			await fs.mkdir(path.join(home, ".pushwork"), { recursive: true });
			await fs.writeFile(path.join(home, ".pushwork", "daemon.lock"), `${old.pid} on-its-way-out`);
			await fs.writeFile(pidFile(), String(old.pid));
			// and a machine so busy the next daemon takes seconds to start
			const slow = path.join(work, "slow.js");
			await fs.writeFile(slow, "for (const end = Date.now() + 3000; Date.now() < end; );\n");
			await pushwork(["init", "--offline"], repo, { ...env, NODE_OPTIONS: `--require ${slow}` });
		} finally {
			old.kill();
		}
	});

	it("starts another daemon when the one it started is stopped before it says hello", async () => {
		// another process (the library, say) stops the new daemon the moment it's listening
		let stopped = 0;
		let watching = true;
		const watcher = (async () => {
			while (watching) {
				const pid = Number(await readText(pidFile()).catch(() => "")) || 0;
				if (pid && !stopped) {
					stopped = pid;
					process.kill(pid);
				}
				await new Promise(r => setTimeout(r, 2));
			}
		})();
		try {
			await run(["init", "--offline"]);
		} finally {
			watching = false;
			await watcher;
		}
		expect(stopped).not.toBe(0);
		expect(await daemonPid()).not.toBe(stopped);
	});

	it("a killed daemon is replaced on the next command", async () => {
		await run(["init", "--offline"]);
		const pid = await daemonPid();
		process.kill(pid, "SIGKILL");
		expect(await until(() => !alive(pid), 5000)).toBe(true);
		await run(["status"]);
		const next = await daemonPid();
		expect(next).not.toBe(pid);
		expect(alive(next)).toBe(true);
	});

	it("a newer daemon build restarts it", async () => {
		// a copy of dist/ beside it, so ../package.json and ../node_modules still resolve, and
		// the daemons of the rest of the suite, which run dist/ itself, aren't disturbed
		const copy = path.join(ROOT, `dist-test-${path.basename(work)}`);
		await fs.cp(DIST, copy, { recursive: true });
		const copied = async (args: string[]) => {
			const { stdout, stderr } = await promisify(execFile)("node", [path.join(copy, "cli.js"), ...args], {
				cwd: repo,
				env: { ...process.env, ...env, NO_COLOR: "1" },
			});
			expect(stdout + stderr).not.toContain("couldn't start the pushwork daemon");
		};
		try {
			await copied(["init", "--offline"]);
			const pid = await daemonPid();
			const daemonJs = path.join(copy, "daemon.js");
			const { atime, mtime } = await fs.stat(daemonJs);
			await fs.utimes(daemonJs, atime, new Date(mtime.getTime() + 60_000));
			await copied(["status"]);
			const next = await daemonPid();
			expect(next).not.toBe(pid);
			expect(alive(pid)).toBe(false);
			expect(alive(next)).toBe(true);
			await copied(["daemon", "stop"]);
		} finally {
			await fs.rm(copy, { recursive: true, force: true });
		}
	});

	it("two daemons started at once over a dead one's socket: one serves, and stays", async () => {
		await run(["init", "--offline"]);
		const dead = await daemonPid();
		process.kill(dead, "SIGKILL");
		expect(await until(() => !alive(dead), 5000)).toBe(true);
		// what a crash leaves: the lock, the pid file, and (but for a named pipe) the socket
		expect(await exists(path.join(home, ".pushwork", "daemon.lock"))).toBe(true);
		if (process.platform !== "win32") expect(await exists(socketPath(home))).toBe(true);

		const daemons = [0, 1].map(() =>
			spawn(process.execPath, [CLI, "daemon", "run"], { env: { ...process.env, ...env }, stdio: "ignore" }),
		);
		const exits = daemons.map(d => new Promise(resolve => d.once("exit", resolve)));
		// the other gives up on the lock as soon as the first answers
		await Promise.race([...exits, new Promise(resolve => setTimeout(resolve, 15_000))]);
		const running = daemons.filter(d => d.exitCode === null && d.signalCode === null);
		expect(running).toHaveLength(1);
		const pid = running[0].pid!;
		expect(await until(async () => (await daemonPid().catch(() => 0)) === pid, 10_000)).toBe(true);

		await run(["status"]);
		await run(["status"]);
		expect(await daemonPid()).toBe(pid);
		expect(alive(pid)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("keeps its socket where only its user can reach it", async () => {
		// a short home, so the socket is in its .pushwork/run rather than /tmp
		const short = await fs.mkdtemp("/tmp/pw-");
		const shortEnv = homeEnv(short);
		try {
			const runDir = path.join(short, ".pushwork", "run");
			// left loose: the daemon tightens it
			await fs.mkdir(runDir, { recursive: true });
			await fs.chmod(runDir, 0o755);
			expect(socketPath(short)).toBe(path.join(runDir, "daemon.sock"));
			await pushwork(["init", "--offline"], repo, shortEnv);
			expect((await fs.stat(runDir)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(socketPath(short))).mode & 0o777).toBe(0o600);
		} finally {
			await stopDaemons();
			await fs.rm(short, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("keeps a long home's socket in a private directory in /tmp", async () => {
		const long = path.join(work, "h".repeat(100));
		await fs.mkdir(long);
		await pushwork(["init", "--offline"], repo, homeEnv(long));
		const sock = socketPath(long);
		expect(sock.startsWith(`/tmp/pushwork-${process.getuid!()}/`)).toBe(true);
		expect((await fs.stat(path.dirname(sock))).mode & 0o777).toBe(0o700);
		expect((await fs.stat(sock)).mode & 0o777).toBe(0o600);
	});

	it("--no-daemon stops a running daemon and works without one", async () => {
		await run(["init", "--offline"]);
		const pid = await daemonPid();
		await run(["--no-daemon", "status"]);
		expect(alive(pid)).toBe(false);
		expect((await run(["daemon", "status"])).stdout).toMatch(/not running/);
	});

	it("errors come back with their message and exit 1", async () => {
		await run(["init", "--offline"]);
		const outside = path.join(work, "outside");
		await fs.mkdir(outside);
		await expect(run(["status"], outside)).rejects.toThrow(/not a pushwork repo/);
		const failed = await promisify(execFile)("node", [CLI, "status"], {
			cwd: outside,
			env: { ...process.env, ...env, NO_COLOR: "1" },
		}).catch(e => e);
		expect(failed.code).toBe(1);
		expect(failed.stderr + failed.stdout).toMatch(/not a pushwork repo/);
		// it ran in the daemon, which is still there
		expect(alive(await daemonPid())).toBe(true);
	});

	it("refuses to call anything but a command", async () => {
		await run(["init", "--offline"]);
		const socket = net.connect(socketPath(home));
		await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
		const peer = new RpcPeer(socket);
		try {
			for (const fn of ["plural", "nuclearizeRepo", "constructor", "__proto__", "toString"]) {
				await expect(peer.call("call", [fn, [], repo])).rejects.toThrow(`unknown command ${fn}`);
			}
			expect(await peer.call("call", ["url", [repo], repo])).toMatch(/^automerge:/);
		} finally {
			peer.close();
		}
	});

	it("resolves a relative path against the command's directory", async () => {
		await fs.copyFile(SLAY, path.join(repo, "slay.js"));
		await fs.writeFile(path.join(repo, "package.json"), '{ "type": "module" }\n');
		await run(["init", "--offline", "--shape", "./slay.js"]);
		expect((await run(["--porcelain", "status"])).stdout).toBe("");
	});

	it("loads a shape installed again under the same name afresh", async () => {
		const bad = path.join(work, "bad.js");
		await fs.writeFile(bad, "export default {}");
		await expect(run(["shape", "install", "--name", "s", bad])).rejects.toThrow("not a shape");
		await run(["shape", "install", "--name", "s", SLAY]);
		await run(["init", "--offline", "--shape", "s"]);
		expect((await run(["--porcelain", "status"])).stdout).toBe("");
	});

	it("exits when its home is deleted", { timeout: 60_000 }, async () => {
		await run(["init", "--offline"]);
		const pid = await daemonPid();
		await fs.rm(home, { recursive: true, force: true });
		expect(await until(() => !alive(pid), 40_000)).toBe(true);
	});

	it("a sync after migrate through the daemon publishes the imported commits", async () => {
		// a version 6 checkout: init in its own home, with an edit saved but never synced,
		// then that home's store put where v6 kept it
		const h1 = path.join(work, "h1");
		await fs.mkdir(h1);
		const old = (args: string[]) => pushwork(["--no-daemon", ...args], repo, homeEnv(h1));
		await old(["init", "--sync-server", server.url]);
		const url = (await old(["url"])).stdout.trim();
		await fs.writeFile(path.join(repo, "notes.txt"), "saved, not synced\n");
		await old(["save"]);
		// the daemon's node has the repo's documents loaded, as the server has them
		await run(["clone", "--sync-server", server.url, url, path.join(work, "seen")], work);
		await fs.rename(path.join(h1, ".pushwork", "storage"), path.join(repo, ".pushwork", "storage"));
		await fs.rm(path.join(repo, ".pushwork", "heads.json"));
		const configFile = path.join(repo, ".pushwork", "config.json");
		const config = JSON.parse(await readText(configFile));
		await fs.writeFile(configFile, JSON.stringify({ ...config, version: 6, syncServer: UNREACHABLE }, null, 2));

		await run(["migrate", "--sync-server", server.url]);
		await run(["sync"]);

		const h3 = path.join(work, "h3");
		await fs.mkdir(h3);
		const copy = path.join(work, "copy");
		await pushwork(["clone", "--sync-server", server.url, url, copy], work, homeEnv(h3));
		expect(await readText(path.join(copy, "notes.txt"))).toBe("saved, not synced\n");
	});

	it("two commands in different checkouts run at once", async () => {
		const other = path.join(work, "other");
		await fs.mkdir(other);
		await fs.writeFile(path.join(other, "notes.txt"), "other\n");
		await run(["init", "--sync-server", server.url]);
		await run(["init", "--sync-server", server.url], other);
		await fs.writeFile(path.join(repo, "notes.txt"), "two\n");
		await fs.writeFile(path.join(other, "notes.txt"), "other two\n");
		await Promise.all([run(["sync"]), run(["sync"], other)]);
		expect((await run(["--porcelain", "status"])).stdout).toBe("");
		expect((await run(["--porcelain", "status"], other)).stdout).toBe("");
		expect(await exists(path.join(home, ".pushwork", "daemon.pid"))).toBe(true);
	});
});
