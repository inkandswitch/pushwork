// Commands run in a daemon per home, which keeps its server connections open between them.
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as net from "net";
import * as path from "path";
import * as tmp from "tmp";
import { promisify } from "util";
import { RpcPeer } from "../../src/rpc";
import { socketPath } from "../../src/daemon";
import { exists, pushwork, readText, stopDaemons } from "../cli";
import { homeEnv } from "../home";
import { startServer } from "../server";

const DAEMON_JS = path.join(__dirname, "..", "..", "dist", "daemon.js");
const CLI = path.join(__dirname, "..", "..", "dist", "cli.js");
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
		await run(["init", "--offline"]);
		const pid = await daemonPid();
		const { atime, mtime } = await fs.stat(DAEMON_JS);
		try {
			await fs.utimes(DAEMON_JS, atime, new Date(mtime.getTime() + 60_000));
			await run(["status"]);
			const next = await daemonPid();
			expect(next).not.toBe(pid);
			expect(alive(pid)).toBe(false);
		} finally {
			await fs.utimes(DAEMON_JS, atime, mtime);
		}
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
