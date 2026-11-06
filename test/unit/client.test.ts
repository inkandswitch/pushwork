import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { busyWith, daemonStatus, hangUp, reachable, remote, stopDaemon } from "../../src/client";
import { busyFile, daemonVersion, pidFile, privateDir, socketPath } from "../../src/daemon";
import { RpcPeer } from "../../src/rpc";
import { setHome } from "../home";

// A stand-in daemon in a temp home: it answers hello, and drops the connection on any call.
describe("client", () => {
	let home: string;
	let restoreHome: () => void;
	let daemon: net.Server;
	let connections = 0;

	beforeEach(async () => {
		// short, so the socket is in the home's own .pushwork/run, not the /tmp directory other tests share
		home = fs.mkdtempSync(process.platform === "win32" ? path.join(os.tmpdir(), "pushwork-client-") : "/tmp/pw-client-");
		restoreHome = setHome(home);
		const sock = socketPath(home);
		fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
		connections = 0;
		daemon = net.createServer(socket => {
			connections++;
			const peer = new RpcPeer(socket, async method => {
				if (method === "hello") return { version: daemonVersion(), pid: process.pid };
				setTimeout(() => socket.destroy(), 50);
				return new Promise(() => {});
			});
			void peer;
		});
		await new Promise<void>(resolve => daemon.listen(sock, resolve));
	});

	afterEach(async () => {
		await new Promise(resolve => daemon.close(resolve));
		restoreHome();
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("says the daemon stopped when the connection drops mid-command", async () => {
		const api = await remote();
		await expect(api.status(home)).rejects.toThrow(
			new Error("the pushwork daemon stopped while running this command"),
		);
	});

	const unix = process.platform !== "win32";

	it.skipIf(!unix)("won't connect through a socket directory other users can use", async () => {
		const dir = path.dirname(socketPath(home));
		expect(dir.startsWith(home)).toBe(true);
		fs.chmodSync(dir, 0o755);
		expect(await reachable()).toEqual({ state: "down" });
		expect(connections).toBe(0);
		fs.chmodSync(dir, 0o700);
		const p = await reachable();
		expect(p.state).toBe("up");
		if (p.state === "up") p.peer.close();
	});

	it.skipIf(!unix || process.getuid?.() === 0)("won't trust a socket directory that belongs to someone else", async () => {
		// root's
		await expect(privateDir("/")).rejects.toThrow(/belongs to someone else/);
		await expect(privateDir("/", { fix: true })).rejects.toThrow(/belongs to someone else/);
	});

	it.skipIf(!unix)("takes a private directory of the user's own, and tightens one when it may", async () => {
		const dir = path.join(home, "run");
		expect(await privateDir(dir)).toBe("missing");
		expect(await privateDir(dir, { fix: true })).toBe("private");
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
		fs.chmodSync(dir, 0o750);
		expect(await privateDir(dir)).toBe("loose");
		expect(await privateDir(dir, { fix: true })).toBe("private");
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
	});
});

const alive = (pid: number) => {
	try {
		return process.kill(pid, 0);
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

async function until(check: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 50));
	return check();
}

describe("a daemon that's busy", () => {
	const call = (since: number) => ({ fn: "sync", cwd: "/somewhere", since });
	const now = 1_000_000_000;

	it("is waited for while it has a call in flight", () => {
		expect(busyWith({ pid: 7, calls: [call(now - 60_000)] }, 7, true, now)).toEqual(call(now - 60_000));
	});

	it("is waited for on its oldest call", () => {
		const busy = { pid: 7, calls: [call(now - 1000), { fn: "init", cwd: "/old", since: now - 5000 }] };
		expect(busyWith(busy, 7, true, now)).toEqual({ fn: "init", cwd: "/old", since: now - 5000 });
	});

	it("isn't, once its oldest call has run over ten minutes", () => {
		const busy = { pid: 7, calls: [call(now - 1000), call(now - 10 * 60_000 - 1)] };
		expect(busyWith(busy, 7, true, now)).toBeUndefined();
	});

	it("isn't, with nothing in flight, no busy file, or a busy file that's another daemon's", () => {
		expect(busyWith({ pid: 7, calls: [] }, 7, true, now)).toBeUndefined();
		expect(busyWith(undefined, 7, true, now)).toBeUndefined();
		expect(busyWith({ pid: 8, calls: [call(now)] }, 7, true, now)).toBeUndefined();
	});

	it("isn't, once its pid is gone", () => {
		expect(busyWith({ pid: 7, calls: [call(now)] }, 7, false, now)).toBeUndefined();
		expect(busyWith({ pid: 0, calls: [call(now)] }, 0, true, now)).toBeUndefined();
	});
});

// A stand-in daemon that takes connections and says nothing, as one does while a long command
// blocks its loop, until it's told to answer; its pid is a process of its own.
describe("a daemon that doesn't answer", () => {
	let home: string;
	let restoreHome: () => void;
	let daemon: net.Server;
	let sockets: Set<net.Socket>;
	let answering: boolean;
	let pid: ChildProcess;

	beforeEach(async () => {
		home = fs.mkdtempSync(process.platform === "win32" ? path.join(os.tmpdir(), "pushwork-client-") : "/tmp/pw-client-");
		restoreHome = setHome(home);
		const sock = socketPath(home);
		fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
		sockets = new Set();
		answering = false;
		daemon = net.createServer(socket => {
			sockets.add(socket);
			socket.on("error", () => {});
			if (answering) {
				new RpcPeer(socket, async method => {
					// and goes, leaving its socket to another daemon, as a new one started by a command would take it
					if (method === "stop") pid.kill("SIGKILL");
					return { version: daemonVersion(), pid: pid.pid };
				});
			}
		});
		await new Promise<void>(resolve => daemon.listen(sock, resolve));
		pid = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], { stdio: "ignore" });
		await new Promise(resolve => pid.once("spawn", resolve));
		// the socket's directory is in it but on Windows, where the socket is a pipe
		fs.mkdirSync(path.dirname(pidFile(home)), { recursive: true });
		fs.writeFileSync(pidFile(home), String(pid.pid));
	});

	afterEach(async () => {
		pid.kill("SIGKILL");
		for (const socket of sockets) socket.destroy();
		await new Promise(resolve => daemon.close(resolve));
		restoreHome();
		fs.rmSync(home, { recursive: true, force: true });
	});

	const busy = (calls: { fn: string; cwd: string; since: number }[]) =>
		fs.writeFileSync(busyFile(home), JSON.stringify({ pid: pid.pid, calls }));
	const BUSY = "waiting for the pushwork daemon (busy with sync in /somewhere)";

	it("doesn't make a negative timeout", async () => {
		const warnings: string[] = [];
		const onWarning = (w: Error) => warnings.push(w.name);
		process.on("warning", onWarning);
		try {
			expect((await reachable()).state).toBe("silent");
		} finally {
			process.off("warning", onWarning);
		}
		expect(warnings).not.toContain("TimeoutNegativeWarning");
	});

	it("is waited for by a command while it's busy, not terminated", async () => {
		busy([{ fn: "sync", cwd: "/somewhere", since: Date.now() }]);
		const said: string[] = [];
		const reached = remote({ say: m => said.push(m) });
		reached.catch(() => {});
		await until(() => said.includes(BUSY) || !alive(pid.pid!), 20_000);
		expect(alive(pid.pid!)).toBe(true);
		expect(said).toEqual(["waiting for the pushwork daemon…", BUSY]);
		// it answers once its command lets it
		answering = true;
		await reached;
		hangUp();
		expect(alive(pid.pid!)).toBe(true);
		expect(said).toHaveLength(2);
	});

	it("is waited for by `daemon stop` while it's busy, not terminated", async () => {
		busy([{ fn: "sync", cwd: "/somewhere", since: Date.now() }]);
		const said: string[] = [];
		const stopped = stopDaemon({ say: m => said.push(m) });
		await until(() => said.includes(BUSY) || !alive(pid.pid!), 20_000);
		expect(alive(pid.pid!)).toBe(true);
		expect(said).toEqual([BUSY]);
		// and then it goes
		pid.kill("SIGKILL");
		for (const socket of sockets) socket.destroy();
		await new Promise(resolve => daemon.close(resolve));
		await stopped;
	});

	it("is done with once it has exited, though the socket is another daemon's by then", { timeout: 90_000 }, async () => {
		answering = true;
		const start = Date.now();
		expect(await stopDaemon()).toBe(true);
		expect(alive(pid.pid!)).toBe(false);
		expect(Date.now() - start).toBeLessThan(10_000);
	});

	it("is terminated with nothing in flight", async () => {
		busy([]);
		const said: string[] = [];
		await stopDaemon({ say: m => said.push(m) });
		expect(await until(() => !alive(pid.pid!), 5000)).toBe(true);
		expect(said).toEqual([]);
	});

	it("shows in daemon status as busy, or not answering", async () => {
		busy([{ fn: "sync", cwd: "/somewhere", since: 5 }]);
		// even a call that's run for ages: status only says what the daemon's doing
		expect(await daemonStatus()).toEqual({ state: "busy", pid: pid.pid, call: { fn: "sync", cwd: "/somewhere", since: 5 } });
		busy([]);
		expect(await daemonStatus()).toEqual({ state: "silent", pid: pid.pid });
	});
});

describe("a daemon that's slow to answer", () => {
	let home: string;
	let restoreHome: () => void;
	let daemon: net.Server;
	let delay: number;

	beforeEach(async () => {
		home = fs.mkdtempSync(process.platform === "win32" ? path.join(os.tmpdir(), "pushwork-client-") : "/tmp/pw-client-");
		restoreHome = setHome(home);
		const sock = socketPath(home);
		fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
		daemon = net.createServer(socket => {
			socket.on("error", () => {});
			new RpcPeer(socket, async () => {
				await new Promise(r => setTimeout(r, delay));
				return { version: daemonVersion(), pid: process.pid };
			});
		});
		await new Promise<void>(resolve => daemon.listen(sock, resolve));
	});

	afterEach(async () => {
		hangUp();
		await new Promise(resolve => daemon.close(resolve));
		restoreHome();
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("is waited for out loud after a second", async () => {
		delay = 1500;
		const said: string[] = [];
		await remote({ say: m => said.push(m) });
		expect(said).toEqual(["waiting for the pushwork daemon…"]);
	});

	it("isn't, when it answers at once", async () => {
		delay = 0;
		const said: string[] = [];
		await remote({ say: m => said.push(m) });
		expect(said).toEqual([]);
	});
});
