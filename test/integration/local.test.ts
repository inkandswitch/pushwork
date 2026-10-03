// The offline commands: save, status, diff, heads, cut, paste.
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { inject } from "vitest";
import { CONFIG_VERSION } from "../../src/config.js";
import { pushwork, readText } from "../cli";
import { startSilentServer } from "../server";

const server = inject("server");

describe("pushwork local-only commands", () => {
	let work: string;
	let cleanup: () => void;

	beforeEach(() => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		work = t.name;
		cleanup = t.removeCallback;
	});

	afterEach(() => cleanup());

	async function initRepo(serverUrl = server) {
		await fs.writeFile(path.join(work, "a.txt"), "hello\n");
		await pushwork(["init", "--server", serverUrl], work);
	}

	describe("status", () => {
		it("is clean immediately after init", async () => {
			await initRepo();
			const { stdout } = await pushwork(["status"], work);
			expect(stdout).toContain("nothing to save");
		});

		it("reports added/modified/deleted", async () => {
			await initRepo();
			await fs.writeFile(path.join(work, "a.txt"), "edited\n");
			await fs.writeFile(path.join(work, "doomed.txt"), "delete me\n");
			await pushwork(["save"], work);
			await fs.unlink(path.join(work, "doomed.txt"));
			await fs.writeFile(path.join(work, "a.txt"), "edited again\n");
			await fs.writeFile(path.join(work, "another.txt"), "new2\n");

			const { stdout } = await pushwork(["status"], work);
			expect(stdout).toContain("modified:   a.txt");
			expect(stdout).toContain("added:      another.txt");
			expect(stdout).toContain("deleted:    doomed.txt");
		});
	});

	describe("save", () => {
		it("works when the repo's server is unreachable", async () => {
			await initRepo("ws://127.0.0.1:1");
			await fs.writeFile(path.join(work, "b.txt"), "two\n");
			expect((await pushwork(["status"], work)).stdout).toContain("added:      b.txt");
			await pushwork(["save"], work);
			expect((await pushwork(["status"], work)).stdout).toContain("nothing to save");
		});

		it("`commit` is an alias for save", async () => {
			await initRepo();
			await fs.writeFile(path.join(work, "c.txt"), "c\n");
			await pushwork(["commit"], work);
			expect((await pushwork(["status"], work)).stdout).toContain("nothing to save");
		});
	});

	describe("diff", () => {
		it("shows a unified diff for modified files", async () => {
			await initRepo();
			await fs.writeFile(path.join(work, "a.txt"), "hello world\n");
			const { stdout } = await pushwork(["diff"], work);
			expect(stdout).toContain("-hello");
			expect(stdout).toContain("+hello world");
		});

		it("prints (no changes) when clean", async () => {
			await initRepo();
			const { stdout } = await pushwork(["diff"], work);
			expect(stdout.trim()).toBe("(no changes)");
		});
	});

	it("offline commands never connect to the server", async () => {
		const silent = await startSilentServer();
		await initRepo();
		const configFile = path.join(work, ".pushwork", "config.json");
		const config = JSON.parse(await readText(configFile));
		await fs.writeFile(configFile, JSON.stringify({ ...config, server: silent.url }));
		await fs.writeFile(path.join(work, "a.txt"), "edited\n");
		for (const command of ["status", "diff", "heads", "cut", "paste", "save"]) {
			await pushwork([command], work);
		}
		expect(await readText(path.join(work, "a.txt"))).toBe("edited\n");
		expect(silent.connections()).toBe(0);
		await silent.close();
	});

	describe("config", () => {
		it("records the current version and the server", async () => {
			await initRepo();
			const config = JSON.parse(await readText(path.join(work, ".pushwork", "config.json")));
			expect(config.version).toBe(CONFIG_VERSION);
			expect(config.server).toBe(server);
		});

		it("init --offline records no server", async () => {
			await pushwork(["init", "--offline"], work);
			const config = JSON.parse(await readText(path.join(work, ".pushwork", "config.json")));
			expect(config.server).toBeUndefined();
		});
	});
});
