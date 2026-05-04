/**
 * White-box tests: import src/ directly and verify the on-disk Automerge doc
 * structure (BranchesDoc wrapping, file-doc indirection, artifact pinning,
 * branch isolation). All tests run fully offline.
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
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { Repo as RepoCtor } from "@automerge/automerge-repo";

import {
	init,
	save,
	createBranch,
	switchBranch,
	currentBranch,
	listBranches,
	mergeBranch,
	previewMerge,
	cutWorkdir,
	pasteStash,
	showStashes,
	nuclearizeRepo,
	type BranchesDoc,
	isBranchesDoc,
	detectDocType,
	type UnixFileEntry,
} from "../../src/index.js";
import { readConfig } from "../../src/config.js";

async function openOfflineRepo(storage: string): Promise<Repo> {
	await initSubduction();
	const adapter = new NodeFSStorageAdapter(storage);
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

	it("BranchesDoc and DirectoryDoc get @patchwork.title set to the folder name", async () => {
		const named = path.join(workRoot, "my-pushwork-repo");
		await fs.mkdir(named);
		await fs.writeFile(path.join(named, "a.txt"), "a\n");
		const rootUrl = await init({
			dir: named,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await withRepo(path.join(named, ".pushwork", "storage"), async (repo) => {
			const root = await repo.find(rootUrl);
			const branches = readDoc(root) as BranchesDoc;
			expect(branches["@patchwork"].title).toBe("my-pushwork-repo");
			const folder = await repo.find(branches.branches.default);
			const folderDoc = readDoc(folder) as {
				"@patchwork": { type: string; title?: string };
			};
			expect(folderDoc["@patchwork"].title).toBe("my-pushwork-repo");
		});
	});

	it("init wraps the folder doc in a BranchesDoc by default", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "hi\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		const cfg = await readConfig(workRoot);
		expect(cfg.branches).toBe(true);

		await withRepo(storageOf(workRoot), async (repo) => {
			const root = await repo.find(cfg.rootUrl);
			expect(detectDocType(root.doc())).toBe("branches");
			const doc = readDoc(root) as BranchesDoc;
			expect(isBranchesDoc(doc)).toBe(true);
			expect(Object.keys(doc.branches)).toEqual(["default"]);
			const folderUrl = doc.branches.default;
			const folder = await repo.find(folderUrl);
			expect(detectDocType(folder.doc())).toBe("directory");
		});
	});

	it("init --no-branches skips the BranchesDoc wrapper", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "hi\n");
		const rootUrl = await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			branches: false,
			online: false,
		});
		const cfg = await readConfig(workRoot);
		expect(cfg.branches).toBe(false);
		expect(cfg.rootUrl).toBe(rootUrl);
		await withRepo(storageOf(workRoot), async (repo) => {
			const root = await repo.find(rootUrl);
			expect(detectDocType(root.doc())).toBe("directory");
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
			const root = await repo.find(cfg.rootUrl);
			const doc = readDoc(root) as BranchesDoc;
			const folder = await repo.find(doc.branches.default);
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
			const root = await repo.find(cfg.rootUrl);
			const doc = readDoc(root) as BranchesDoc;
			const folder = await repo.find(doc.branches.default);
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
			const root = await repo.find(cfg.rootUrl);
			const doc = readDoc(root) as BranchesDoc;
			const folder = await repo.find(doc.branches.default);
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

	it("file URLs stay stable within a branch across edits (mutation, not clone)", async () => {
		// pushFiles mutates the existing UnixFileEntry doc in place, which
		// keeps the file URL stable within a branch. (Branch isolation comes
		// from createBranch deep-cloning, not from per-edit cloning.)
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
				const root = await repo.find(cfg.rootUrl);
				const doc = readDoc(root) as BranchesDoc;
				const folder = await repo.find(doc.branches.default);
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
				const root = await repo.find(cfg.rootUrl);
				const doc = readDoc(root) as BranchesDoc;
				const folder = await repo.find(doc.branches.default);
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

describe("branch isolation", () => {
	let workRoot: string;
	let cleanup: () => void;

	beforeEach(() => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		workRoot = t.name;
		cleanup = t.removeCallback;
	});

	afterEach(() => cleanup());

	const storageOf = (root: string) => path.join(root, ".pushwork", "storage");

	it("branch <name> creates a new branch with independent file-doc URLs", async () => {
		// `createBranch` deep-clones every file doc the source folder
		// references so editing on one branch can never alias the other.
		await fs.writeFile(path.join(workRoot, "a.txt"), "hi\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await createBranch(workRoot, "feat");

		const cfg = await readConfig(workRoot);
		await withRepo(storageOf(workRoot), async (repo) => {
			const root = await repo.find(cfg.rootUrl);
			const doc = readDoc(root) as BranchesDoc;
			const defaultUrl = doc.branches.default;
			const featUrl = doc.branches.feat;
			expect(defaultUrl).not.toBe(featUrl);

			const def = readDoc(await repo.find(defaultUrl)) as Record<
				string,
				unknown
			>;
			const feat = readDoc(await repo.find(featUrl)) as Record<
				string,
				unknown
			>;
			// File URLs differ (clone), but content matches.
			expect(feat["a.txt"]).not.toBe(def["a.txt"]);
			const defFile = readDoc(
				await repo.find(def["a.txt"] as `automerge:${string}`),
			) as UnixFileEntry;
			const featFile = readDoc(
				await repo.find(feat["a.txt"] as `automerge:${string}`),
			) as UnixFileEntry;
			expect(featFile.content).toBe(defFile.content);
		});
	});

	it("editing on a branch does not change the source branch's folder doc", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "hi\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await createBranch(workRoot, "feat");

		const cfg = await readConfig(workRoot);
		const beforeDefault = await withRepo(storageOf(workRoot), async (repo) => {
			const root = await repo.find(cfg.rootUrl);
			const doc = readDoc(root) as BranchesDoc;
			const folder = await repo.find(doc.branches.default);
			return (readDoc(folder) as Record<string, unknown>)["a.txt"];
		});

		await switchBranch(workRoot, "feat");
		await fs.writeFile(path.join(workRoot, "a.txt"), "edited on feat\n");
		await save(workRoot);

		const afterDefault = await withRepo(storageOf(workRoot), async (repo) => {
			const root = await repo.find(cfg.rootUrl);
			const doc = readDoc(root) as BranchesDoc;
			const folder = await repo.find(doc.branches.default);
			return (readDoc(folder) as Record<string, unknown>)["a.txt"];
		});

		expect(afterDefault).toBe(beforeDefault); // default's folder doc unchanged
	});

	it("merge brings non-conflicting source changes into target", async () => {
		await fs.writeFile(path.join(workRoot, "shared.txt"), "shared\n");
		await fs.writeFile(path.join(workRoot, "target.txt"), "T\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await createBranch(workRoot, "feat");
		await switchBranch(workRoot, "feat");

		// Edit shared.txt and add a new file on feat.
		await fs.writeFile(path.join(workRoot, "shared.txt"), "shared edited on feat\n");
		await fs.writeFile(path.join(workRoot, "feat-only.txt"), "F\n");
		await save(workRoot);

		// Switch back to default and edit target.txt only.
		await switchBranch(workRoot, "default");
		await fs.writeFile(path.join(workRoot, "target.txt"), "T edited on default\n");
		await save(workRoot);

		const report = await mergeBranch(workRoot, "feat");
		expect(report.source).toBe("feat");
		expect(report.target).toBe("default");
		expect(report.merged.sort()).toEqual(["shared.txt", "target.txt"]);
		expect(report.added).toEqual(["feat-only.txt"]);

		expect(await fs.readFile(path.join(workRoot, "shared.txt"), "utf8")).toBe(
			"shared edited on feat\n",
		);
		expect(await fs.readFile(path.join(workRoot, "target.txt"), "utf8")).toBe(
			"T edited on default\n",
		);
		expect(await fs.readFile(path.join(workRoot, "feat-only.txt"), "utf8")).toBe(
			"F\n",
		);
	});

	it("merge refuses on dirty working tree", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "a\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		// createBranch auto-switches to feat; switch back to default so the
		// merge has a different source.
		await createBranch(workRoot, "feat");
		await switchBranch(workRoot, "default");
		await fs.writeFile(path.join(workRoot, "dirty.txt"), "uncommitted\n");
		await expect(mergeBranch(workRoot, "feat")).rejects.toThrow(
			/uncommitted changes/,
		);
	});

	it("merge does character-level CRDT merge on text content", async () => {
		await fs.writeFile(path.join(workRoot, "x.txt"), "line one\nline two\nline three\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await createBranch(workRoot, "other");
		await switchBranch(workRoot, "other");
		await fs.writeFile(
			path.join(workRoot, "x.txt"),
			"line one\nline two\nline three EDITED ON OTHER\n",
		);
		await save(workRoot);
		await switchBranch(workRoot, "default");
		await fs.writeFile(
			path.join(workRoot, "x.txt"),
			"line one EDITED ON DEFAULT\nline two\nline three\n",
		);
		await save(workRoot);
		await mergeBranch(workRoot, "other");

		const merged = await fs.readFile(path.join(workRoot, "x.txt"), "utf8");
		expect(merged).toContain("line one EDITED ON DEFAULT");
		expect(merged).toContain("line three EDITED ON OTHER");
	});

	it("previewMerge shows entries without mutating", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "v1\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await createBranch(workRoot, "feat");
		await switchBranch(workRoot, "feat");
		await fs.writeFile(path.join(workRoot, "a.txt"), "v2\n");
		await fs.writeFile(path.join(workRoot, "new.txt"), "n\n");
		await save(workRoot);
		await switchBranch(workRoot, "default");

		const preview = await previewMerge(workRoot, "feat");
		const paths = preview.entries.map((e) => e.path).sort();
		expect(paths).toEqual(["a.txt", "new.txt"]);
		expect(preview.entries.find((e) => e.path === "a.txt")?.kind).toBe(
			"merged",
		);
		expect(preview.entries.find((e) => e.path === "new.txt")?.kind).toBe(
			"added",
		);
		// Working tree unchanged on disk:
		expect(await fs.readFile(path.join(workRoot, "a.txt"), "utf8")).toBe("v1\n");
		expect(await pathExists(path.join(workRoot, "new.txt"))).toBe(false);
	});

	it("merge errors on missing source branch", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "a\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await expect(mergeBranch(workRoot, "ghost")).rejects.toThrow(/does not exist/);
	});

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

		const stashes = await showStashes(workRoot);
		expect(stashes.length).toBe(1);
		expect(stashes[0].name).toBe("wip");
		expect(stashes[0].branch).toBe("default");

		await pasteStash(workRoot);

		expect(await fs.readFile(path.join(workRoot, "mod.txt"), "utf8")).toBe(
			"v2\n",
		);
		expect(await fs.readFile(path.join(workRoot, "added.txt"), "utf8")).toBe(
			"new\n",
		);
		expect(await pathExists(path.join(workRoot, "doomed.txt"))).toBe(false);

		expect((await showStashes(workRoot)).length).toBe(0);
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
		await expect(pasteStash(workRoot)).rejects.toThrow(/uncommitted/);
	});

	it("paste with no stashes errors", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "a\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await expect(pasteStash(workRoot)).rejects.toThrow(/no stashes/);
	});

	it("paste with id selects a specific stash", async () => {
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

		const out = await pasteStash(workRoot, String(c1.id));
		expect(out.id).toBe(c1.id);
		expect(await pathExists(path.join(workRoot, "first.txt"))).toBe(true);
		// Second stash is still there
		const stashes = await showStashes(workRoot);
		expect(stashes.length).toBe(1);
		expect(stashes[0].id).toBe(c2.id);
	});

	it("nuclearizeRepo regenerates every URL while preserving content", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "A\n");
		await fs.writeFile(path.join(workRoot, "b.txt"), "B\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		await createBranch(workRoot, "feat");
		await fs.writeFile(path.join(workRoot, "feat-only.txt"), "F\n");
		await save(workRoot);

		const cfg1 = await readConfig(workRoot);

		const oldUrls: string[] = [];
		await withRepo(path.join(workRoot, ".pushwork", "storage"), async (repo) => {
			const root = await repo.find(cfg1.rootUrl);
			const doc = readDoc(root) as BranchesDoc;
			oldUrls.push(cfg1.rootUrl);
			for (const url of Object.values(doc.branches)) {
				oldUrls.push(url);
				const folder = await repo.find(url);
				for (const [k, v] of Object.entries(readDoc(folder) as Record<string, unknown>)) {
					if (k === "@patchwork" || k === "lastSyncAt") continue;
					if (typeof v === "string") oldUrls.push(v);
				}
			}
		});

		await nuclearizeRepo(workRoot);

		const cfg2 = await readConfig(workRoot);
		expect(cfg2.rootUrl).not.toBe(cfg1.rootUrl);

		const newUrls: string[] = [];
		await withRepo(path.join(workRoot, ".pushwork", "storage"), async (repo) => {
			const root = await repo.find(cfg2.rootUrl);
			const doc = readDoc(root) as BranchesDoc;
			newUrls.push(cfg2.rootUrl);
			for (const url of Object.values(doc.branches)) {
				newUrls.push(url);
				const folder = await repo.find(url);
				for (const [k, v] of Object.entries(readDoc(folder) as Record<string, unknown>)) {
					if (k === "@patchwork" || k === "lastSyncAt") continue;
					if (typeof v === "string") newUrls.push(v);
				}
			}
			// Same shape: branches still default + feat
			expect(Object.keys(doc.branches).sort()).toEqual(["default", "feat"]);
			// Content preserved on feat: feat-only.txt still there
			const feat = await repo.find(doc.branches.feat);
			const featDoc = readDoc(feat) as Record<string, unknown>;
			expect("feat-only.txt" in featDoc).toBe(true);
		});

		// No URL appears in both old and new sets.
		const oldSet = new Set(oldUrls);
		for (const u of newUrls) expect(oldSet.has(u)).toBe(false);
	});

	it("listBranches reports current and all names", async () => {
		await fs.writeFile(path.join(workRoot, "a.txt"), "hi\n");
		await init({
			dir: workRoot,
			backend: "subduction",
			shape: "vfs",
			online: false,
		});
		// createBranch auto-switches; switch back so we can create another from
		// default's history.
		await createBranch(workRoot, "feat");
		await switchBranch(workRoot, "default");
		await createBranch(workRoot, "bugfix");
		// We're now on bugfix (auto-switch).
		const out = await listBranches(workRoot);
		expect(out.current).toBe("bugfix");
		expect(out.names.sort()).toEqual(["bugfix", "default", "feat"]);

		expect(await currentBranch(workRoot)).toBe("bugfix");
		await switchBranch(workRoot, "feat");
		expect(await currentBranch(workRoot)).toBe("feat");
	});
});
