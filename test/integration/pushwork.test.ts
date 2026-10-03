// Black-box: drive the built CLI against the hermetic test server.
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { inject } from "vitest";
import { exists, pushwork, readText, userFiles } from "../cli";

const server = inject("server");

const init = (dir: string) => pushwork(["init", "--sync-server", server], dir);
const clone = (url: string, dir: string) => pushwork(["clone", "--sync-server", server, url, dir]);
const urlOf = async (dir: string) => (await pushwork(["url"], dir)).stdout.trim();

// Sync each repo once, in order.
async function sync(...repos: string[]) {
	for (const r of repos) await pushwork(["sync"], r);
}

describe("pushwork", () => {
	let work: string;
	let cleanup: () => void;

	beforeEach(() => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		work = t.name;
		cleanup = t.removeCallback;
	});

	afterEach(() => cleanup());

	async function dir(name: string) {
		const d = path.join(work, name);
		await fs.mkdir(d, { recursive: true });
		return d;
	}

	async function pair() {
		const a = await dir("a");
		await init(a);
		const b = path.join(work, "b");
		await clone(await urlOf(a), b);
		return { a, b };
	}

	describe("init", () => {
		it("succeeds on an empty directory", async () => {
			const a = await dir("a");
			const { stdout } = await init(a);
			expect(stdout).toContain("SYNCED");
			expect([...(await userFiles(a)).keys()]).toEqual([]);
		});

		it("does not alter pre-existing files", async () => {
			const a = await dir("a");
			await fs.writeFile(path.join(a, "keep.txt"), "do not touch");
			await fs.mkdir(path.join(a, "subdir"));
			await fs.writeFile(path.join(a, "subdir", "nested.txt"), "nested");
			await init(a);
			expect(await readText(path.join(a, "keep.txt"))).toBe("do not touch");
			expect(await readText(path.join(a, "subdir", "nested.txt"))).toBe("nested");
		});
	});

	describe("url", () => {
		it("prints a stable automerge: URL", async () => {
			const a = await dir("a");
			await init(a);
			const url = await urlOf(a);
			expect(url).toMatch(/^automerge:[1-9A-HJ-NP-Za-km-z]+$/);
			expect(await urlOf(a)).toBe(url);
		});

		it("differs between two repos", async () => {
			const a = await dir("a");
			const b = await dir("b");
			await init(a);
			await init(b);
			expect(await urlOf(a)).not.toBe(await urlOf(b));
		});
	});

	describe("clone", () => {
		it("reproduces a nested tree with binary content", async () => {
			const a = await dir("a");
			await fs.mkdir(path.join(a, "src", "components"), { recursive: true });
			await fs.writeFile(path.join(a, "package.json"), '{"name":"x"}');
			await fs.writeFile(path.join(a, "src", "index.ts"), "export {}");
			await fs.writeFile(path.join(a, "src", "components", "Button.tsx"), "export const Button = () => null");
			await fs.writeFile(path.join(a, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe]));
			await init(a);
			const b = path.join(work, "b");
			await clone(await urlOf(a), b);
			expect(await userFiles(b)).toEqual(await userFiles(a));
			expect(await urlOf(b)).toBe(await urlOf(a));
		});

		it("does not sync .git or node_modules", async () => {
			const a = await dir("a");
			await fs.writeFile(path.join(a, "ok.txt"), "ok");
			await fs.mkdir(path.join(a, "node_modules"));
			await fs.writeFile(path.join(a, "node_modules", "lib.js"), "lib");
			await fs.mkdir(path.join(a, ".git"));
			await fs.writeFile(path.join(a, ".git", "HEAD"), "ref");
			await init(a);
			const b = path.join(work, "b");
			await clone(await urlOf(a), b);
			expect(await exists(path.join(b, "ok.txt"))).toBe(true);
			expect(await exists(path.join(b, "node_modules"))).toBe(false);
			expect(await exists(path.join(b, ".git"))).toBe(false);
		});

		it("fails when the server is unreachable", async () => {
			const a = await dir("a");
			await init(a);
			await expect(
				pushwork(["clone", "--sync-server", "ws://127.0.0.1:1", await urlOf(a), path.join(work, "b")]),
			).rejects.toThrow(/could not connect/);
		});
	});

	describe("track", () => {
		it("adopts the url without touching files, and status shows the difference", async () => {
			const a = await dir("a");
			await fs.writeFile(path.join(a, "same.txt"), "same");
			await fs.writeFile(path.join(a, "remote.txt"), "remote");
			await init(a);
			const b = await dir("b");
			await fs.writeFile(path.join(b, "same.txt"), "same");
			await fs.writeFile(path.join(b, "local.txt"), "local");
			await pushwork(["track", "--sync-server", server, await urlOf(a)], b);

			expect([...(await userFiles(b)).keys()].sort()).toEqual(["local.txt", "same.txt"]);
			expect(await urlOf(b)).toBe(await urlOf(a));
			const status = (await pushwork(["--porcelain", "status"], b)).stdout;
			expect(status.trim().split("\n").sort()).toEqual(["added\tlocal.txt", "deleted\tremote.txt"]);
		});

		it("then syncs local edits to the url", async () => {
			const a = await dir("a");
			await fs.writeFile(path.join(a, "x.txt"), "v1");
			await init(a);
			const b = await dir("b");
			await fs.writeFile(path.join(b, "x.txt"), "v2");
			await pushwork(["track", "--sync-server", server, await urlOf(a)], b);
			await sync(b, a);
			expect(await readText(path.join(a, "x.txt"))).toBe("v2");
		});
	});

	describe("merge", () => {
		it("keeps files from both sides and the local copy wins", async () => {
			const a = await dir("a");
			await fs.writeFile(path.join(a, "both.txt"), "remote");
			await fs.mkdir(path.join(a, "sub"));
			await fs.writeFile(path.join(a, "sub", "remote.txt"), "remote only");
			await init(a);
			const b = await dir("b");
			await fs.writeFile(path.join(b, "both.txt"), "local");
			await fs.writeFile(path.join(b, "local.txt"), "local only");
			await pushwork(["merge", "--sync-server", server, await urlOf(a)], b);
			await sync(a);

			const expected = new Map([
				["both.txt", Buffer.from("local")],
				["local.txt", Buffer.from("local only")],
				[path.join("sub", "remote.txt"), Buffer.from("remote only")],
			]);
			expect(await userFiles(b)).toEqual(expected);
			expect(await userFiles(a)).toEqual(expected);
		});
	});

	describe("migrate", () => {
		it("upgrades a pushwork 2 repo in place, keeping the old state", async () => {
			const a = await dir("a");
			await fs.writeFile(path.join(a, "x.txt"), "v1");
			await init(a);
			const b = await dir("b");
			await fs.writeFile(path.join(b, "x.txt"), "v1");
			await fs.writeFile(path.join(b, "new.txt"), "local edit");
			await fs.mkdir(path.join(b, ".pushwork"));
			const oldConfig = { version: 5, rootUrl: await urlOf(a), backend: "subduction", shape: "vfs" };
			await fs.writeFile(path.join(b, ".pushwork", "config.json"), JSON.stringify(oldConfig));
			await fs.writeFile(path.join(b, ".pushwork", "storage.lmdb"), "old");

			await expect(pushwork(["status"], b)).rejects.toThrow(/pushwork migrate/);
			await pushwork(["migrate", "--sync-server", server], b);

			expect(await urlOf(b)).toBe(await urlOf(a));
			expect(await readText(path.join(b, ".pushwork", "pushwork_migration_backup_safe_to_delete", "storage.lmdb"))).toBe("old");
			const status = (await pushwork(["--porcelain", "status"], b)).stdout;
			expect(status.trim()).toBe("added\tnew.txt");
			await sync(b, a);
			expect(await readText(path.join(a, "new.txt"))).toBe("local edit");
		});
	});

	describe("slay shape", () => {
		const slay = path.join(__dirname, "..", "..", "examples", "shapes", "slay.js");

		it("round-trips nested, binary and deleted files, and merges concurrent text edits", async () => {
			const a = await dir("a");
			await fs.mkdir(path.join(a, "lib"));
			await fs.writeFile(path.join(a, "entry.tsx"), "one\ntwo\nthree\n");
			await fs.writeFile(path.join(a, "lib", "util.ts"), "export {}");
			await fs.writeFile(path.join(a, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0xff]));
			await fs.writeFile(path.join(a, "doomed.txt"), "bye");
			await pushwork(["init", "--sync-server", server, "--shape", slay], a);
			const b = path.join(work, "b");
			await pushwork(["clone", "--sync-server", server, "--shape", slay, await urlOf(a), b]);
			expect(await userFiles(b)).toEqual(await userFiles(a));

			await fs.writeFile(path.join(a, "entry.tsx"), "ONE\ntwo\nthree\n");
			await fs.rm(path.join(a, "doomed.txt"));
			await fs.writeFile(path.join(b, "entry.tsx"), "one\ntwo\nTHREE\n");
			await sync(a, b, a);
			expect(await readText(path.join(a, "entry.tsx"))).toBe("ONE\ntwo\nTHREE\n");
			expect(await userFiles(b)).toEqual(await userFiles(a));
			expect(await exists(path.join(b, "doomed.txt"))).toBe(false);
		});
	});

	describe("sync", () => {
		it("propagates a new file from A to B", async () => {
			const { a, b } = await pair();
			await fs.writeFile(path.join(a, "added.txt"), "new in A");
			await sync(a, b);
			expect(await readText(path.join(b, "added.txt"))).toBe("new in A");
		});

		it("propagates a new file from B to A", async () => {
			const { a, b } = await pair();
			await fs.writeFile(path.join(b, "from-b.txt"), "new in B");
			await sync(b, a);
			expect(await readText(path.join(a, "from-b.txt"))).toBe("new in B");
		});

		it("propagates modifications and deletions", async () => {
			const { a, b } = await pair();
			await fs.writeFile(path.join(a, "x.txt"), "v1");
			await fs.writeFile(path.join(a, "doomed.txt"), "doomed");
			await sync(a, b);
			expect(await readText(path.join(b, "x.txt"))).toBe("v1");
			expect(await exists(path.join(b, "doomed.txt"))).toBe(true);

			await fs.writeFile(path.join(a, "x.txt"), "v2");
			await fs.unlink(path.join(a, "doomed.txt"));
			await sync(a, b);
			expect(await readText(path.join(b, "x.txt"))).toBe("v2");
			expect(await exists(path.join(b, "doomed.txt"))).toBe(false);
		});

		it("propagates changes inside a nested directory", async () => {
			const { a, b } = await pair();
			await fs.mkdir(path.join(a, "deep", "deeper"), { recursive: true });
			await fs.writeFile(path.join(a, "deep", "deeper", "leaf.txt"), "leaf v1");
			await sync(a, b);
			expect(await readText(path.join(b, "deep", "deeper", "leaf.txt"))).toBe("leaf v1");

			await fs.writeFile(path.join(a, "deep", "deeper", "leaf.txt"), "leaf v2");
			await sync(a, b);
			expect(await readText(path.join(b, "deep", "deeper", "leaf.txt"))).toBe("leaf v2");
		});

		it("converges concurrent disjoint edits", async () => {
			const { a, b } = await pair();
			await fs.writeFile(path.join(a, "from-a.txt"), "A");
			await fs.writeFile(path.join(b, "from-b.txt"), "B");
			await sync(a, b, a);
			expect(await userFiles(a)).toEqual(await userFiles(b));
			expect(await readText(path.join(a, "from-b.txt"))).toBe("B");
			expect(await readText(path.join(b, "from-a.txt"))).toBe("A");
		});

		it("converges patchwork-folder repos with artifacts", async () => {
			const a = await dir("a");
			await fs.mkdir(path.join(a, "dist"));
			await fs.writeFile(path.join(a, "dist", "main.js"), "v1");
			await fs.writeFile(path.join(a, "README"), "hi");
			await pushwork(["init", "--sync-server", server, "--shape", "patchwork-folder"], a);
			const b = path.join(work, "b");
			await clone(await urlOf(a), b);
			expect(await userFiles(b)).toEqual(await userFiles(a));

			await fs.writeFile(path.join(b, "dist", "main.js"), "v2");
			await fs.mkdir(path.join(b, "src"));
			await fs.writeFile(path.join(b, "src", "app.ts"), "app");
			await sync(b, a);
			expect(await userFiles(a)).toEqual(await userFiles(b));
		});

		it("reports SYNCED in porcelain output", async () => {
			const { a } = await pair();
			const { stdout } = await pushwork(["--porcelain", "sync"], a);
			expect(stdout).toContain("sync\tsynced");
			expect(stdout).toMatch(new RegExp(`^root\t${await urlOf(a)}\t\\S+`, "m"));
			expect(stdout).not.toContain("unsynced");
		});

		it("a third clone catches up", async () => {
			const { a, b } = await pair();
			await fs.writeFile(path.join(a, "shared.txt"), "shared");
			await sync(a);
			const c = path.join(work, "c");
			await clone(await urlOf(b), c);
			expect(await readText(path.join(c, "shared.txt"))).toBe("shared");
		});

		it("--nuclear keeps the root url and the peer follows", async () => {
			const { a, b } = await pair();
			await fs.writeFile(path.join(a, "n.txt"), "one");
			await sync(a, b);
			await pushwork(["sync", "--nuclear"], a);
			await fs.writeFile(path.join(a, "n.txt"), "two");
			await sync(a, b);
			expect(await urlOf(a)).toBe(await urlOf(b));
			expect(await readText(path.join(b, "n.txt"))).toBe("two");
		});
	});

	describe("yoink / yeet", () => {
		async function fileUrl(repo: string, file: string): Promise<string> {
			const { stdout } = await pushwork(["heads", file], repo);
			const line = stdout.split("\n").find(l => l.startsWith(file + "\t"));
			if (!line) throw new Error(`no heads entry for ${file}:\n${stdout}`);
			return line.split("\t")[1];
		}

		it("yoinks a file doc into another repo", async () => {
			const a = await dir("a");
			const b = await dir("b");
			await fs.writeFile(path.join(a, "note.md"), "hello");
			await init(a);
			await init(b);
			const url = await fileUrl(a, "note.md");
			await pushwork(["yoink", url, "grabbed.md"], b);
			await pushwork(["yoink", url], b);
			expect(await readText(path.join(b, "grabbed.md"))).toBe("hello");
			expect(await readText(path.join(b, "note.md"))).toBe("hello");
		});

		it("yoinks outside a repo", async () => {
			const a = await dir("a");
			const out = await dir("out");
			await fs.writeFile(path.join(a, "note.md"), "loose");
			await init(a);
			await pushwork(["yoink", "--sync-server", server, await fileUrl(a, "note.md")], out);
			expect(await readText(path.join(out, "note.md"))).toBe("loose");
		});

		it("yoinking a tracked doc doesn't undo the next sync's pull", async () => {
			const a = await dir("a");
			await fs.writeFile(path.join(a, "note.md"), "v1");
			await init(a);
			const b = path.join(work, "b");
			await clone(await urlOf(a), b);
			await fs.writeFile(path.join(b, "note.md"), "v2");
			await sync(b);
			await pushwork(["yoink", await fileUrl(a, "note.md"), "copy.md"], a);
			expect(await readText(path.join(a, "copy.md"))).toBe("v2");
			await sync(a);
			expect(await readText(path.join(a, "note.md"))).toBe("v2");
		});

		it("yeets a local file into a doc and the owner sees it", async () => {
			const a = await dir("a");
			const b = await dir("b");
			await fs.writeFile(path.join(a, "note.md"), "v1");
			await init(a);
			await init(b);
			await fs.writeFile(path.join(b, "out.md"), "v2 from b");
			await pushwork(["yeet", "out.md", await fileUrl(a, "note.md")], b);
			await sync(a);
			expect(await readText(path.join(a, "note.md"))).toBe("v2 from b");
		});

		it("rejects an invalid URL", async () => {
			const a = await dir("a");
			await init(a);
			await expect(pushwork(["yoink", "not-a-url"], a)).rejects.toThrow(/invalid automerge URL/);
		});
	});

	it("supports a two-user session", async () => {
		const alice = await dir("alice");
		await fs.writeFile(path.join(alice, "README"), "# Project");
		await fs.mkdir(path.join(alice, "src"));
		await fs.writeFile(path.join(alice, "src", "main.ts"), "// v1");
		await init(alice);
		const bob = path.join(work, "bob");
		await clone(await urlOf(alice), bob);
		expect(await userFiles(bob)).toEqual(await userFiles(alice));

		await fs.writeFile(path.join(bob, "src", "main.ts"), "// v2 (bob)");
		await fs.writeFile(path.join(bob, "src", "util.ts"), "export const x = 1");
		await fs.writeFile(path.join(alice, "README"), "# Project\n\nNotes");
		await sync(alice, bob, alice);
		expect(await readText(path.join(alice, "src", "main.ts"))).toBe("// v2 (bob)");
		expect(await readText(path.join(alice, "src", "util.ts"))).toBe("export const x = 1");
		expect(await readText(path.join(bob, "README"))).toBe("# Project\n\nNotes");

		await fs.unlink(path.join(bob, "src", "util.ts"));
		await sync(bob, alice);
		expect(await exists(path.join(alice, "src", "util.ts"))).toBe(false);
		expect(await userFiles(alice)).toEqual(await userFiles(bob));
	});
});
