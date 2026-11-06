import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { reachable, remote } from "../../src/client";
import { daemonVersion, privateDir, socketPath } from "../../src/daemon";
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
