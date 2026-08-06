/**
 * White-box tests: import src/ directly and verify the on-disk Automerge doc
 * structure (folder doc, file-doc indirection, artifact pinning). All tests
 * run fully offline.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
import {
	initSubduction,
	parseAutomergeUrl,
	isImmutableString,
	type DocHandle,
	type Repo,
} from "@automerge/automerge-repo";
import { LMDBStorageAdapter } from "@automerge/automerge-repo-storage-lmdb";
import { Repo as RepoCtor } from "@automerge/automerge-repo";

import {
	init,
	save,
	cutWorkdir,
	pasteSnarf,
	showSnarfs,
	nuclearizeRepo,
	type UnixFileEntry,
} from "../../src/index.js";
import { readConfig } from "../../src/config.js";

async function openOfflineRepo(storage: string): Promise<Repo> {
	await initSubduction();
	// Same layout as src/repo.ts openRepo: single-file LMDB at `<storage>.lmdb`.
	const adapter = new LMDBStorageAdapter(`${storage}.lmdb`);
	return new RepoCtor({ storage: adapter, network: [] });
}

async function withRepo<T>(
	storage: string,
	fn: (repo: Repo) => Promise<T>,
): Promise<T> {
	const repo = await openOfflineRepo(storage);
	try {
		return await fn(repo);
	} finally {
		await repo.shutdown();
	}
}

function readDoc<T>(handle: DocHandle<T>): T {
	const d = handle.doc();
	if (!d) throw new Error(`empty doc at ${handle.url}`);
	return d;
}

describe("doc shape", () => {
	let workRoot: string;
	let cleanup: () => void;

	beforeEach(() => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		workRoot = t.name;
		cleanup = t.removeCallback;
	});

	afterEach(() => cleanup());

	const storageOf = (root: string) => path.join(root, ".pushwork", "storage");

	it("the folder doc gets @patchwork.title set to the folder name", async () => {
		const named = path.join(workRoot, "my-pushwork-repo");
		await fs.mkdir(named);
		await fs.writeFile(path.join(named, "a.txt"), "a\n");
		const { url: rootUrl } = await init({
			dir: named,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await withRepo(path.join(named, ".pushwork", "storage"), async (repo) => {
			const root = await repo.find(rootUrl);
			const folderDoc = readDoc(root) as {
				"@patchwork": { type: string; title?: string };
			};
			expect(folderDoc["@patchwork"].type).toBe("directory");
			expect(folderDoc["@patchwork"].title).toBe("my-pushwork-repo");
		});
	});

	it("init returns a folder doc URL directly", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "hi\n");
		const { url: rootUrl, files } = await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		const cfg = await readConfig(workRoot);
		expect(cfg.rootUrl).toBe(rootUrl);
		expect(files).toBe(1);

		await withRepo(storageOf(workRoot), async (repo) => {
			const root = await repo.find(rootUrl);
			const folderDoc = readDoc(root) as {
				"@patchwork": { type: string };
			};
			expect(folderDoc["@patchwork"].type).toBe("directory");
		});
	});

	it("file content is stored in separate UnixFileEntry docs (indirection)", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "hello world\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		const cfg = await readConfig(workRoot);
		await withRepo(storageOf(workRoot), async (repo) => {
			const folder = await repo.find(cfg.rootUrl);
			const folderDoc = readDoc(folder) as Record<string, unknown>;
			const fileUrl = folderDoc["a.txt"];
			expect(typeof fileUrl).toBe("string");
			const file = await repo.find(fileUrl as `automerge:${string}`);
			const fd = readDoc(file) as UnixFileEntry;
			expect(fd["@patchwork"].type).toBe("file");
			expect(fd.content).toBe("hello world\n");
		});
	});

	it("artifact files store ImmutableString content and pin URL with heads", async () => {
		await fs.mkdir(path.join(workRoot, "dist"));
		await fs.writeFile(path.join(workRoot, "dist", "main.js"), "console.log(1)\n");
		await fs.writeFile(path.join(workRoot, "src.ts"), "export {}\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		const cfg = await readConfig(workRoot);
		await withRepo(storageOf(workRoot), async (repo) => {
			const folder = await repo.find(cfg.rootUrl);
			const folderDoc = readDoc(folder) as Record<string, unknown>;

			const artifactUrl = folderDoc["dist/main.js"] as string;
			const sourceUrl = folderDoc["src.ts"] as string;
			expect(parseAutomergeUrl(artifactUrl).heads).toBeTruthy();
			expect(parseAutomergeUrl(sourceUrl).heads).toBeFalsy();

			const artifactDoc = readDoc(await repo.find(artifactUrl)) as UnixFileEntry;
			expect(isImmutableString(artifactDoc.content)).toBe(true);

			const sourceDoc = readDoc(await repo.find(sourceUrl)) as UnixFileEntry;
			expect(typeof sourceDoc.content).toBe("string");
			expect(isImmutableString(sourceDoc.content)).toBe(false);
		});
	});

	it(".pushworkattributes overrides the default artifact dirs", async () => {
		// Default behavior pins `dist/`. Here we override via the repo-carried
		// attributes file: pin `out/` instead, and explicitly un-pin `dist/`.
		await fs.mkdir(path.join(workRoot, "dist"));
		await fs.mkdir(path.join(workRoot, "out"));
		await fs.writeFile(path.join(workRoot, "dist", "main.js"), "console.log(1)\n");
		await fs.writeFile(path.join(workRoot, "out", "bundle.js"), "console.log(2)\n");
		await fs.writeFile(
			path.join(workRoot, ".pushworkattributes"),
			["out/**  artifact", "dist/** -artifact"].join("\n") + "\n",
		);
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
			// Passed but ignored: the attributes file is authoritative.
			artifactDirectories: ["dist"],
		});

		// config.json defers to the attributes file (stored list left empty).
		const cfg = await readConfig(workRoot);
		expect(cfg.artifactDirectories).toEqual([]);

		await withRepo(storageOf(workRoot), async (repo) => {
			const folder = await repo.find(cfg.rootUrl);
			const folderDoc = readDoc(folder) as Record<string, unknown>;
			// out/ is pinned (heads present); dist/ is not.
			expect(
				parseAutomergeUrl(folderDoc["out/bundle.js"] as string).heads,
			).toBeTruthy();
			expect(
				parseAutomergeUrl(folderDoc["dist/main.js"] as string).heads,
			).toBeFalsy();
		});
	});

	it("patchwork-folder pins artifact-dir folders, not source folders", async () => {
		await fs.mkdir(path.join(workRoot, "dist"));
		await fs.mkdir(path.join(workRoot, "src"));
		await fs.writeFile(path.join(workRoot, "dist", "main.js"), "console.log(1)\n");
		await fs.writeFile(path.join(workRoot, "src", "app.ts"), "export const x = 1\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "patchwork-folder",
			online: false,
			artifactDirectories: ["dist"],
		});

		const cfg = await readConfig(workRoot);

		type Link = { name: string; type: string; url: `automerge:${string}` };
		type FolderDoc = { docs: Link[] };
		const linkByName = (docs: Link[], name: string) => {
			const l = docs.find((d) => d.name === name);
			if (!l) throw new Error(`no link named ${name}`);
			return l;
		};

		await withRepo(storageOf(workRoot), async (repo) => {
			const root = await repo.find(cfg.rootUrl);
			const rootDoc = readDoc(root) as FolderDoc;

			// The artifact dir's folder link carries heads; the source dir's
			// folder link is bare. The root doc URL itself is never pinned.
			const distLink = linkByName(rootDoc.docs, "dist");
			const srcLink = linkByName(rootDoc.docs, "src");
			expect(distLink.type).toBe("folder");
			expect(parseAutomergeUrl(distLink.url).heads).toBeTruthy();
			expect(parseAutomergeUrl(srcLink.url).heads).toBeFalsy();
			expect(parseAutomergeUrl(cfg.rootUrl).heads).toBeFalsy();

			// Inside each subfolder: the artifact file leaf is pinned, the
			// source file leaf is not.
			const distFolder = await repo.find(distLink.url);
			const mainLink = linkByName(readDoc(distFolder).docs as Link[], "main.js");
			expect(parseAutomergeUrl(mainLink.url).heads).toBeTruthy();

			const srcFolder = await repo.find(srcLink.url);
			const appLink = linkByName(readDoc(srcFolder).docs as Link[], "app.ts");
			expect(parseAutomergeUrl(appLink.url).heads).toBeFalsy();
		});

		// Re-encoding (e.g. a later save) keeps the artifact folder doc URL
		// stable: we strip the pin to edit the live doc rather than recreating.
		const distUrlBefore = await withRepo(storageOf(workRoot), async (repo) => {
			const root = await repo.find(cfg.rootUrl);
			return parseAutomergeUrl(
				linkByName((readDoc(root) as FolderDoc).docs, "dist").url,
			).documentId;
		});
		await save(workRoot);
		await withRepo(storageOf(workRoot), async (repo) => {
			const root = await repo.find(cfg.rootUrl);
			const distLink = linkByName((readDoc(root) as FolderDoc).docs, "dist");
			expect(parseAutomergeUrl(distLink.url).documentId).toBe(distUrlBefore);
			expect(parseAutomergeUrl(distLink.url).heads).toBeTruthy();
		});
	});

	it("patchwork-folder pins only the configured artifact dir, not its parent", async () => {
		// artifactDirectories = ["a/b"]. The parent `a` holds nothing but the
		// artifact subdir `a/b`, so an all-children-pinned heuristic would wrongly
		// freeze `a`. Driven by the classifier, only `a/b` is pinned.
		await fs.mkdir(path.join(workRoot, "a", "b"), { recursive: true });
		await fs.writeFile(path.join(workRoot, "a", "b", "x.js"), "x\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "patchwork-folder",
			online: false,
			artifactDirectories: ["a/b"],
		});
		const cfg = await readConfig(workRoot);

		type Link = { name: string; type: string; url: `automerge:${string}` };
		type FolderDoc = { docs: Link[] };
		const linkByName = (docs: Link[], name: string) => {
			const l = docs.find((d) => d.name === name);
			if (!l) throw new Error(`no link named ${name}`);
			return l;
		};

		await withRepo(storageOf(workRoot), async (repo) => {
			const root = await repo.find(cfg.rootUrl);
			const aLink = linkByName((readDoc(root) as FolderDoc).docs, "a");
			expect(parseAutomergeUrl(aLink.url).heads).toBeFalsy();

			const aFolder = await repo.find(aLink.url);
			const bLink = linkByName((readDoc(aFolder) as FolderDoc).docs, "b");
			expect(parseAutomergeUrl(bLink.url).heads).toBeTruthy();
		});
	});

	it("binary files store content as Uint8Array", async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]);
		await fs.writeFile(path.join(workRoot, "img.png"), bytes);
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		const cfg = await readConfig(workRoot);
		await withRepo(storageOf(workRoot), async (repo) => {
			const folder = await repo.find(cfg.rootUrl);
			const folderDoc = readDoc(folder) as Record<string, unknown>;
			const file = await repo.find(folderDoc["img.png"] as `automerge:${string}`);
			const fd = readDoc(file) as UnixFileEntry;
			expect(fd.content instanceof Uint8Array).toBe(true);
			expect(Array.from(fd.content as Uint8Array)).toEqual(Array.from(bytes));
		});
	});
});

describe("file-doc lifecycle", () => {
	let workRoot: string;
	let cleanup: () => void;

	beforeEach(() => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		workRoot = t.name;
		cleanup = t.removeCallback;
	});

	afterEach(() => cleanup());

	const storageOf = (root: string) => path.join(root, ".pushwork", "storage");

	it("file URLs stay stable across edits (mutation, not clone)", async () => {
		// pushFiles mutates the existing UnixFileEntry doc in place, which
		// keeps the file URL stable across edits.
		await fs.writeFile(path.join(workRoot, "stable.txt"), "stable\n");
		await fs.writeFile(path.join(workRoot, "edited.txt"), "v1\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});

		async function urlFor(filePath: string): Promise<string> {
			const cfg = await readConfig(workRoot);
			return withRepo(storageOf(workRoot), async (repo) => {
				const folder = await repo.find(cfg.rootUrl);
				const folderDoc = readDoc(folder) as Record<string, unknown>;
				return folderDoc[filePath] as string;
			});
		}

		const stableUrl1 = await urlFor("stable.txt");
		const editedUrl1 = await urlFor("edited.txt");

		await fs.writeFile(path.join(workRoot, "edited.txt"), "v2\n");
		await save(workRoot);

		const stableUrl2 = await urlFor("stable.txt");
		const editedUrl2 = await urlFor("edited.txt");

		expect(stableUrl2).toBe(stableUrl1);
		expect(editedUrl2).toBe(editedUrl1);
	});

	it("save does not stamp lastSyncAt; sync would (offline test of negative case)", async () => {
		await fs.writeFile(path.join(workRoot, "x.txt"), "x\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});

		async function lastSyncAt(): Promise<number | undefined> {
			const cfg = await readConfig(workRoot);
			return withRepo(storageOf(workRoot), async (repo) => {
				const folder = await repo.find(cfg.rootUrl);
				return (readDoc(folder) as { lastSyncAt?: number }).lastSyncAt;
			});
		}

		// init with online:false skips the lastSyncAt stamp too
		expect(await lastSyncAt()).toBeUndefined();

		await fs.writeFile(path.join(workRoot, "x.txt"), "y\n");
		await save(workRoot);

		expect(await lastSyncAt()).toBeUndefined();
	});
});

describe("snarf (cut/paste)", () => {
	let workRoot: string;
	let cleanup: () => void;

	beforeEach(() => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		workRoot = t.name;
		cleanup = t.removeCallback;
	});

	afterEach(() => cleanup());

	it("cut/paste round-trips modifications, additions, and deletions", async () => {
		await fs.writeFile(path.join(workRoot, "mod.txt"), "v1\n");
		await fs.writeFile(path.join(workRoot, "doomed.txt"), "remove me\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await fs.writeFile(path.join(workRoot, "mod.txt"), "v2\n");
		await fs.writeFile(path.join(workRoot, "added.txt"), "new\n");
		await fs.unlink(path.join(workRoot, "doomed.txt"));

		const cut = await cutWorkdir(workRoot, { name: "wip" });
		expect(cut.entries).toBe(3);

		// Working tree restored to clean state:
		expect(await fs.readFile(path.join(workRoot, "mod.txt"), "utf8")).toBe(
			"v1\n",
		);
		expect(
			await fs.readFile(path.join(workRoot, "doomed.txt"), "utf8"),
		).toBe("remove me\n");
		expect(await pathExists(path.join(workRoot, "added.txt"))).toBe(false);

		const snarfs = await showSnarfs(workRoot);
		expect(snarfs.length).toBe(1);
		expect(snarfs[0].name).toBe("wip");

		await pasteSnarf(workRoot);

		expect(await fs.readFile(path.join(workRoot, "mod.txt"), "utf8")).toBe(
			"v2\n",
		);
		expect(await fs.readFile(path.join(workRoot, "added.txt"), "utf8")).toBe(
			"new\n",
		);
		expect(await pathExists(path.join(workRoot, "doomed.txt"))).toBe(false);

		expect((await showSnarfs(workRoot)).length).toBe(0);
	});

	it("cut refuses on a clean working tree", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "a\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await expect(cutWorkdir(workRoot)).rejects.toThrow(/working tree clean/);
	});

	it("paste refuses on a dirty working tree", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "a\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await fs.writeFile(path.join(workRoot, "a.txt"), "edited\n");
		await cutWorkdir(workRoot);
		// dirty the working tree again
		await fs.writeFile(path.join(workRoot, "b.txt"), "extra\n");
		await expect(pasteSnarf(workRoot)).rejects.toThrow(/uncommitted/);
	});

	it("paste with no snarfs errors", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "a\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await expect(pasteSnarf(workRoot)).rejects.toThrow(/no snarfs/);
	});

	it("paste with id selects a specific snarf", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "a\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await fs.writeFile(path.join(workRoot, "first.txt"), "1\n");
		const c1 = await cutWorkdir(workRoot, { name: "first" });
		await fs.writeFile(path.join(workRoot, "second.txt"), "2\n");
		const c2 = await cutWorkdir(workRoot, { name: "second" });

		const out = await pasteSnarf(workRoot, String(c1.id));
		expect(out.id).toBe(c1.id);
		expect(await pathExists(path.join(workRoot, "first.txt"))).toBe(true);
		// Second snarf is still there
		const snarfs = await showSnarfs(workRoot);
		expect(snarfs.length).toBe(1);
		expect(snarfs[0].id).toBe(c2.id);
	});

	it("nuclearizeRepo regenerates every file URL but preserves the root URL", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "A\n");
		await fs.writeFile(path.join(workRoot, "b.txt"), "B\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});

		const cfg1 = await readConfig(workRoot);

		const oldFileUrls: string[] = [];
		await withRepo(path.join(workRoot, ".pushwork", "storage"), async (repo) => {
			const folder = await repo.find(cfg1.rootUrl);
			for (const [k, v] of Object.entries(readDoc(folder) as Record<string, unknown>)) {
				if (k === "@patchwork" || k === "lastSyncAt") continue;
				if (typeof v === "string") oldFileUrls.push(v);
			}
		});

		await nuclearizeRepo(workRoot);

		const cfg2 = await readConfig(workRoot);
		// Root folder URL is preserved across nuclearize.
		expect(cfg2.rootUrl).toBe(cfg1.rootUrl);

		const newFileUrls: string[] = [];
		await withRepo(path.join(workRoot, ".pushwork", "storage"), async (repo) => {
			const folder = await repo.find(cfg2.rootUrl);
			const folderDoc = readDoc(folder) as Record<string, unknown>;
			for (const [k, v] of Object.entries(folderDoc)) {
				if (k === "@patchwork" || k === "lastSyncAt") continue;
				if (typeof v === "string") newFileUrls.push(v);
			}
			// Same content preserved.
			expect("a.txt" in folderDoc).toBe(true);
			expect("b.txt" in folderDoc).toBe(true);
		});

		// Every file URL is brand new.
		const oldSet = new Set(oldFileUrls);
		expect(newFileUrls.length).toBe(oldFileUrls.length);
		for (const u of newFileUrls) expect(oldSet.has(u)).toBe(false);
	});
});
