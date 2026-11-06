import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { remote } from "../../src/client";
import { daemonVersion, socketPath } from "../../src/daemon";
import { RpcPeer } from "../../src/rpc";
import { setHome } from "../home";

// A stand-in daemon in a temp home: it answers hello, and drops the connection on any call.
describe("client", () => {
	let home: string;
	let restoreHome: () => void;
	let daemon: net.Server;

	beforeEach(async () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-client-"));
		restoreHome = setHome(home);
		const sock = socketPath(home);
		fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
		daemon = net.createServer(socket => {
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
});
