// With an unreachable or silent server, init and sync finish promptly, say OFFLINE and stay quiet.
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { pushwork } from "../cli";
import { startSilentServer } from "../server";

// closed loopback port: immediate ECONNREFUSED
const DEAD = "ws://127.0.0.1:1";

tmp.setGracefulCleanup();

describe("unreachable sync server", () => {
	it("init and sync report offline promptly and quietly", async () => {
		const dir = tmp.dirSync({ unsafeCleanup: true }).name;
		for (let i = 0; i < 40; i++) await fs.writeFile(path.join(dir, `file_${i}.txt`), `content ${i}\n`);

		const start = Date.now();
		const init = await pushwork(["--porcelain", "init", "--server", DEAD], dir);
		expect(Date.now() - start).toBeLessThan(8_000);
		expect(init.stdout).toContain("INITIALIZED");
		expect(init.stdout).toContain("sync\toffline");
		expect(init.stdout).toMatch(/^error\t.+/m);

		await fs.writeFile(path.join(dir, "file_0.txt"), "edited\n");
		const sync = await pushwork(["--porcelain", "sync"], dir);
		expect(sync.stdout).toContain("sync\toffline");

		for (const { stdout, stderr } of [init, sync]) {
			expect(stdout + stderr).not.toMatch(/WARN|ERROR/);
			expect(stderr).not.toMatch(/Unhandled|Uncaught/);
		}
	});

	it("init gives up on a server that never answers", async () => {
		const silent = await startSilentServer();
		const dir = tmp.dirSync({ unsafeCleanup: true }).name;
		await fs.writeFile(path.join(dir, "a.txt"), "a\n");
		const start = Date.now();
		const init = await pushwork(["--porcelain", "init", "--server", silent.url], dir);
		// the connect timeout is 10s; exit follows straight after
		expect(Date.now() - start).toBeLessThan(14_000);
		expect(init.stdout).toContain("sync\toffline");
		expect(init.stdout).toMatch(/^error\ttimed out connecting/m);
		await silent.close();
	});
});
