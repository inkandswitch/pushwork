/**
 * White-box tests for drafts: forking, reading and writing a draft, switching,
 * merging and deleting, and the shared on-disk format. All tests run fully
 * offline.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import {
	initSubduction,
	Repo as RepoCtor,
	type AutomergeUrl,
	type Repo,
} from "@automerge/automerge-repo";
import { LMDBStorageAdapter } from "@automerge/automerge-repo-storage-lmdb";

import {
	clone,
	createDraft,
	deleteDraft,
	drafts,
	heads,
	init,
	merge,
	renameDraft,
	save,
	status,
	switchDraft,
	type DraftDoc,
	type UnixFileEntry,
} from "../../src/index.js";
import { readConfig } from "../../src/config.js";
import { repairCloneConflicts } from "../../src/drafts/view.js";

async function withRepo<T>(workRoot: string, fn: (repo: Repo) => Promise<T>): Promise<T> {
	await initSubduction();
	const storage = path.join(workRoot, ".pushwork", "storage.lmdb");
	const repo = new RepoCtor({ storage: new LMDBStorageAdapter(storage), network: [] });
	try {
		return await fn(repo);
	} finally {
		await repo.shutdown();
	}
}

const textOf = (entry: UnixFileEntry | undefined) => String(entry?.content ?? "");

describe.each(["patchwork-folder", "vfs"])("drafts (%s)", (shape) => {
	let workRoot: string;
	let cleanup: () => void;

	beforeEach(async () => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		workRoot = t.name;
		cleanup = t.removeCallback;
		await fs.writeFile(file("a.txt"), "main\n");
		await fs.mkdir(file("sub"));
		await fs.writeFile(file("sub/b.txt"), "b\n");
		await init({ dir: workRoot, backend: "subduction", shape, online: false });
	});

	afterEach(() => cleanup());

	const file = (p: string) => path.join(workRoot, p);
	const read = (p: string) => fs.readFile(file(p), "utf8");
	const urlOf = async (p: string) => (await heads(workRoot, p))[0].url;
	const isClean = async () => {
		const { diff } = await status(workRoot);
		return diff.added.length + diff.modified.length + diff.deleted.length === 0;
	};
	const draftDoc = async (url: AutomergeUrl) =>
		withRepo(workRoot, async (repo) => (await repo.find<DraftDoc>(url)).doc());
	const docAt = async <T>(url: AutomergeUrl) =>
		withRepo(workRoot, async (repo) => (await repo.find<T>(url)).doc());

	it("keeps a draft's edits on the draft and main's on main", async () => {
		const aUrl = await urlOf("a.txt");
		const { draft } = await createDraft(workRoot, { name: "feature", switchTo: true });
		expect((await readConfig(workRoot)).draft).toBe(draft.url);

		// Checking a draft out and reading it clones nothing.
		expect(await isClean()).toBe(true);
		const forked = await draftDoc(draft.url!);
		expect(Object.values(forked!.clones).some((e) => e.cloneUrl)).toBe(false);

		await fs.writeFile(file("a.txt"), "draft\n");
		await fs.writeFile(file("new.txt"), "new\n");
		await save(workRoot);
		expect(await isClean()).toBe(true);
		// The draft's tree still names the original doc.
		expect(await urlOf("a.txt")).toBe(aUrl);

		const doc = await draftDoc(draft.url!);
		const aClone = doc!.clones[aUrl].cloneUrl!;
		expect(aClone).toBeDefined();
		expect(aClone).not.toBe(aUrl);
		expect(textOf(await docAt<UnixFileEntry>(aClone))).toBe("draft\n");
		expect(textOf(await docAt<UnixFileEntry>(aUrl))).toBe("main\n");

		// A doc made on the draft is its own clone.
		const newUrl = await urlOf("new.txt");
		expect(doc!.clones[newUrl]).toEqual({ cloneUrl: newUrl, clonedAt: [] });

		await switchDraft(workRoot, "main");
		expect(await read("a.txt")).toBe("main\n");
		await expect(fs.access(file("new.txt"))).rejects.toThrow();
		expect(await isClean()).toBe(true);

		await switchDraft(workRoot, "feature");
		expect(await read("a.txt")).toBe("draft\n");
		expect(await read("new.txt")).toBe("new\n");
		expect(await read("sub/b.txt")).toBe("b\n");
	});

	it("reads main as it was when the draft forked", async () => {
		await createDraft(workRoot, { name: "early" });
		await fs.writeFile(file("a.txt"), "main moved\n");
		await save(workRoot);

		await switchDraft(workRoot, "early");
		expect(await read("a.txt")).toBe("main\n");
	});

	it("merges into main and switches there", async () => {
		const { draft } = await createDraft(workRoot, { name: "feature", switchTo: true });
		await fs.writeFile(file("a.txt"), "draft\n");
		await fs.writeFile(file("sub/c.txt"), "c\n");
		await save(workRoot);

		const result = await merge(workRoot);
		expect(result.from).toBe("feature");
		expect(result.into).toEqual({ name: "main", url: null });
		expect((await readConfig(workRoot)).draft).toBeNull();
		expect(await read("a.txt")).toBe("draft\n");
		expect(await read("sub/c.txt")).toBe("c\n");
		expect(await isClean()).toBe(true);
		expect((await drafts(workRoot)).drafts).toEqual([]);
		expect((await draftDoc(draft.url!))!.mergedAt).toBeDefined();
	});

	it("merges a sub-draft into the draft it was forked off", async () => {
		await createDraft(workRoot, { name: "feature", switchTo: true });
		await fs.writeFile(file("a.txt"), "feature\n");
		await save(workRoot);
		await createDraft(workRoot, { name: "sub-feature", switchTo: true });
		await fs.writeFile(file("sub/b.txt"), "sub-feature\n");
		await save(workRoot);

		const result = await merge(workRoot);
		expect(result.into.name).toBe("feature");
		expect(await read("a.txt")).toBe("feature\n");
		expect(await read("sub/b.txt")).toBe("sub-feature\n");

		await switchDraft(workRoot, "main");
		expect(await read("a.txt")).toBe("main\n");
		expect(await read("sub/b.txt")).toBe("b\n");
	});

	it("refuses to switch over unsaved changes, but switch -c carries them", async () => {
		await createDraft(workRoot, { name: "other" });
		await fs.writeFile(file("a.txt"), "unsaved\n");
		await expect(switchDraft(workRoot, "other")).rejects.toThrow(/unsaved changes/);

		await createDraft(workRoot, { name: "wip", switchTo: true });
		expect(await read("a.txt")).toBe("unsaved\n");
		expect((await status(workRoot)).diff.modified).toEqual(["a.txt"]);
		await save(workRoot);

		await switchDraft(workRoot, "main");
		expect(await read("a.txt")).toBe("main\n");
	});

	it("deletes only drafts it won't lose work from, unless forced", async () => {
		await createDraft(workRoot, { name: "feature", switchTo: true });
		await expect(deleteDraft(workRoot, "feature")).rejects.toThrow(/checked out/);
		await fs.writeFile(file("a.txt"), "draft\n");
		await save(workRoot);
		await switchDraft(workRoot, "main");

		await expect(deleteDraft(workRoot, "feature")).rejects.toThrow(/-D/);
		await deleteDraft(workRoot, "feature", { force: true });
		expect((await drafts(workRoot)).drafts).toEqual([]);

		await createDraft(workRoot, { name: "untouched" });
		await deleteDraft(workRoot, "untouched");
		expect((await drafts(workRoot)).drafts).toEqual([]);
	});
});

describe("draft bookkeeping", () => {
	let workRoot: string;
	let cleanup: () => void;

	beforeEach(async () => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		workRoot = t.name;
		cleanup = t.removeCallback;
		await fs.writeFile(path.join(workRoot, "a.txt"), "main\n");
		await init({ dir: workRoot, backend: "subduction", shape: "patchwork-folder", online: false });
	});

	afterEach(() => cleanup());

	it("stores drafts in Patchwork's format, with main found through the root", async () => {
		const { draft } = await createDraft(workRoot);
		const { rootUrl } = await readConfig(workRoot);
		await withRepo(workRoot, async (repo) => {
			const root = (await repo.find<{ "@patchwork": { mainDraftUrl?: AutomergeUrl } }>(rootUrl)).doc();
			const mainUrl = root!["@patchwork"].mainDraftUrl!;
			const main = (await repo.find<DraftDoc>(mainUrl)).doc()!;
			expect(main).not.toHaveProperty("isMain");
			expect(main.parent).toBe(rootUrl);
			expect(main.drafts).toEqual([draft.url]);
			const doc = (await repo.find<DraftDoc>(draft.url!)).doc()!;
			expect(doc["@patchwork"]).toEqual({ type: "draft" });
			expect(doc.parent).toBe(mainUrl);
			expect(Object.keys(doc.clones)).toContain(rootUrl);
		});
	});

	it("names drafts Draft N, keeps names unique, and renames", async () => {
		expect((await createDraft(workRoot)).draft.name).toBe("Draft 1");
		expect((await createDraft(workRoot)).draft.name).toBe("Draft 2");
		await expect(createDraft(workRoot, { name: "Draft 1" })).rejects.toThrow(/already exists/);
		await expect(createDraft(workRoot, { name: "main" })).rejects.toThrow(/root's name/);

		await renameDraft(workRoot, "first", "Draft 1");
		expect((await createDraft(workRoot)).draft.name).toBe("Draft 3");
		expect((await drafts(workRoot)).drafts.map((d) => d.name)).toEqual([
			"first",
			"Draft 2",
			"Draft 3",
		]);
	});

	it("lists sub-drafts under the draft they were forked off", async () => {
		await createDraft(workRoot, { name: "a", switchTo: true });
		await createDraft(workRoot, { name: "a1" });
		await createDraft(workRoot, { name: "b", start: "main" });
		const listing = await drafts(workRoot);
		expect(listing.drafts.map((d) => [d.name, d.depth])).toEqual([
			["a", 0],
			["a1", 1],
			["b", 0],
		]);
		expect(listing.current).toBe(listing.drafts[0].url);
	});

	it("clones a draft by its url, or by name with -b", async () => {
		const { draft } = await createDraft(workRoot, { name: "feature", switchTo: true });
		await fs.writeFile(path.join(workRoot, "a.txt"), "draft\n");
		await save(workRoot);
		const { rootUrl } = await readConfig(workRoot);

		// Offline, so seed each target with the source's storage.
		const cloneInto = async (url: AutomergeUrl, opts: { draft?: string } = {}) => {
			const dir = tmp.dirSync({ unsafeCleanup: true }).name;
			await fs.mkdir(path.join(dir, ".pushwork"));
			await fs.copyFile(
				path.join(workRoot, ".pushwork", "storage.lmdb"),
				path.join(dir, ".pushwork", "storage.lmdb"),
			);
			const summary = await clone({
				url,
				dir,
				backend: "subduction",
				shape: "vfs",
				online: false,
				...opts,
			});
			return { dir, summary };
		};

		const byUrl = await cloneInto(draft.url!);
		expect(byUrl.summary.url).toBe(rootUrl);
		expect((await readConfig(byUrl.dir)).draft).toBe(draft.url);
		expect(await fs.readFile(path.join(byUrl.dir, "a.txt"), "utf8")).toBe("draft\n");

		const byName = await cloneInto(rootUrl, { draft: "feature" });
		expect((await readConfig(byName.dir)).draft).toBe(draft.url);
		expect(await fs.readFile(path.join(byName.dir, "a.txt"), "utf8")).toBe("draft\n");

		const main = await cloneInto(rootUrl);
		expect((await readConfig(main.dir)).draft).toBeNull();
		expect(await fs.readFile(path.join(main.dir, "a.txt"), "utf8")).toBe("main\n");
	});

	it("folds together two clones made of the same doc at once", async () => {
		const { draft } = await createDraft(workRoot);
		const { rootUrl } = await readConfig(workRoot);
		const aUrl = (await heads(workRoot, "a.txt"))[0].url;
		await withRepo(workRoot, async (repo) => {
			const here = await repo.find<DraftDoc>(draft.url!);
			const elsewhere = repo.clone(here);
			const original = await repo.find<UnixFileEntry>(aUrl);
			const mine = repo.clone(original);
			const theirs = repo.clone(original);
			mine.change((d: UnixFileEntry) => {
				d.content = "mine\n";
			});
			theirs.change((d: UnixFileEntry) => {
				d.name = "renamed.txt";
			});
			here.change((d: DraftDoc) => {
				d.clones[aUrl].cloneUrl = mine.url;
			});
			elsewhere.change((d: DraftDoc) => {
				d.clones[aUrl].cloneUrl = theirs.url;
			});
			here.merge(elsewhere);

			expect(await repairCloneConflicts(repo, here)).toBe(1);
			const winner = (await repo.find<UnixFileEntry>(here.doc()!.clones[aUrl].cloneUrl!)).doc()!;
			expect(textOf(winner)).toBe("mine\n");
			expect(winner.name).toBe("renamed.txt");
			expect(here.doc()!.clones[rootUrl]).toBeDefined();
		});
	});
});
