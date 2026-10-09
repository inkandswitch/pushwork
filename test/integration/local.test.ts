// The offline commands: save, status, diff, heads, cut, paste; and the url xattrs they leave.
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { inject } from "vitest";
import { getAttributeSync, setAttributeSync } from "@napi-rs/xattr";
import { CONFIG_VERSION } from "../../src/config.js";
import { URL_XATTR } from "../../src/xattr.js";
import { exists, pushwork, readText } from "../cli";
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
		await pushwork(["init", "--sync-server", serverUrl], work);
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
		await fs.writeFile(configFile, JSON.stringify({ ...config, syncServer: silent.url }));
		await fs.writeFile(path.join(work, "a.txt"), "edited\n");
		for (const command of ["status", "diff", "heads", "cut", "paste", "save"]) {
			await pushwork([command], work);
		}
		expect(await readText(path.join(work, "a.txt"))).toBe("edited\n");
		expect(silent.connections()).toBe(0);
		await silent.close();
	});

	describe("url xattrs", () => {
		const urlOf = async (file: string) =>
			(await pushwork(["--porcelain", "heads", file], work)).stdout.split("\t")[1];
		const attr = (file: string) => getAttributeSync(path.join(work, file), URL_XATTR)?.toString();

		it("labels every file with its doc's url", async () => {
			await fs.mkdir(path.join(work, "sub"));
			await fs.writeFile(path.join(work, "sub", "b.txt"), "b\n");
			await initRepo();
			expect(attr("a.txt")).toBe(await urlOf("a.txt"));
			await fs.writeFile(path.join(work, "c.txt"), "c\n");
			await pushwork(["save"], work);
			expect(attr("sub/b.txt")).toBe(await urlOf("sub/b.txt"));
			expect(attr("c.txt")).toBe(await urlOf("c.txt"));
		});

		it("a moved file keeps its doc", async () => {
			await initRepo();
			const url = await urlOf("a.txt");
			await fs.mkdir(path.join(work, "sub"));
			await fs.rename(path.join(work, "a.txt"), path.join(work, "sub", "moved.txt"));
			await pushwork(["save"], work);
			expect(await urlOf("sub/moved.txt")).toBe(url);
			expect(await urlOf("a.txt")).toBeUndefined();
		});

		it("a moved and edited file keeps its doc", async () => {
			await initRepo();
			const url = await urlOf("a.txt");
			await fs.rename(path.join(work, "a.txt"), path.join(work, "b.txt"));
			await fs.writeFile(path.join(work, "b.txt"), "hello again\n");
			await pushwork(["save"], work);
			expect(await urlOf("b.txt")).toBe(url);
			expect((await pushwork(["status"], work)).stdout).toContain("nothing to save");
		});

		it("status shows a moved file as renamed", async () => {
			await initRepo();
			await fs.mkdir(path.join(work, "sub"));
			await fs.rename(path.join(work, "a.txt"), path.join(work, "sub", "moved.txt"));
			const { stdout } = await pushwork(["status"], work);
			expect(stdout).toContain("renamed:    a.txt -> sub/moved.txt");
			expect(stdout).not.toContain("added:");
			expect(stdout).not.toContain("deleted:");
			const porcelain = await pushwork(["--porcelain", "status"], work);
			expect(porcelain.stdout.trim()).toBe("renamed\ta.txt\tsub/moved.txt");
		});

		it("diff shows a rename with its edits, by either path", async () => {
			await initRepo();
			await fs.rename(path.join(work, "a.txt"), path.join(work, "b.txt"));
			await fs.writeFile(path.join(work, "b.txt"), "hello again\n");
			for (const args of [[], ["a.txt"], ["b.txt"]]) {
				const { stdout } = await pushwork(["diff", ...args], work);
				expect(stdout).toContain("*** a.txt -> b.txt");
				expect(stdout).toContain("--- a.txt");
				expect(stdout).toContain("+++ b.txt");
				expect(stdout).toContain("-hello\n");
				expect(stdout).toContain("+hello again");
			}
		});

		it("cut and paste keep a rename", async () => {
			await initRepo();
			const url = await urlOf("a.txt");
			await fs.rename(path.join(work, "a.txt"), path.join(work, "b.txt"));
			await pushwork(["cut"], work);
			expect(await readText(path.join(work, "a.txt"))).toBe("hello\n");
			expect(await exists(path.join(work, "b.txt"))).toBe(false);
			await pushwork(["paste"], work);
			expect(await exists(path.join(work, "a.txt"))).toBe(false);
			expect((await pushwork(["status"], work)).stdout).toContain("renamed:    a.txt -> b.txt");
			await pushwork(["save"], work);
			expect(await urlOf("b.txt")).toBe(url);
		});

		it("a copy gets a doc of its own", async () => {
			await initRepo();
			const url = await urlOf("a.txt");
			await fs.writeFile(path.join(work, "copy.txt"), "hello\n");
			setAttributeSync(path.join(work, "copy.txt"), URL_XATTR, url);
			await pushwork(["save"], work);
			expect(await urlOf("a.txt")).toBe(url);
			const copy = await urlOf("copy.txt");
			expect(copy).not.toBe(url);
			expect(attr("copy.txt")).toBe(copy);
		});
	});

	describe("config", () => {
		it("records the current version and the server", async () => {
			await initRepo();
			const config = JSON.parse(await readText(path.join(work, ".pushwork", "config.json")));
			expect(config.version).toBe(CONFIG_VERSION);
			expect(config.syncServer).toBe(server);
		});

		it("init --offline records no server", async () => {
			await pushwork(["init", "--offline"], work);
			const config = JSON.parse(await readText(path.join(work, ".pushwork", "config.json")));
			expect(config.syncServer).toBeUndefined();
		});
	});
});
