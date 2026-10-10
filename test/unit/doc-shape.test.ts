// White-box: import src/ and check the stored doc structure. Offline.
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { isImmutableString } from "@automerge/automerge";
import { MemorySigner } from "@automerge/automerge-subduction";
import {
	init,
	save,
	cutWorkdir,
	pasteSnarf,
	showSnarfs,
	nuclearizeRepo,
	parseAutomergeUrl,
	type AutomergeUrl,
	type UnixFileEntry,
} from "../../src/index.js";
import { readConfig, storageDir } from "../../src/config.js";
import { Docs } from "../../src/docs.js";
import { FsStorage } from "../../src/storage.js";
import { exists } from "../cli";

type VfsDoc = { "@patchwork": { type: string; title?: string } } & Record<string, unknown>;
type Link = { name: string; type: string; url: AutomergeUrl };
type FolderDoc = { docs: Link[] };

async function withDocs<T>(root: string, fn: (docs: Docs) => Promise<T>): Promise<T> {
	const docs = await Docs.open({ storage: await FsStorage.open(storageDir(root)), signer: MemorySigner.generate() });
	try {
		return await fn(docs);
	} finally {
		await docs.close();
	}
}

// The root doc of the repo at `root`.
const rootDoc = <T>(root: string) =>
	withDocs(root, async docs => docs.find<T>((await readConfig(root)).rootUrl));

function link(folder: FolderDoc, name: string): Link {
	const l = folder.docs.find(d => d.name === name);
	if (!l) throw new Error(`no link named ${name}`);
	return l;
}

const pinned = (url: string) => parseAutomergeUrl(url).heads !== undefined;

let work: string;
let cleanup: () => void;

beforeEach(() => {
	const t = tmp.dirSync({ unsafeCleanup: true });
	work = t.name;
	cleanup = t.removeCallback;
});

afterEach(() => cleanup());

const initVfs = (opts: { artifactDirectories?: string[] } = {}) =>
	init({ dir: work, shape: "vfs", online: false, ...opts });

describe("doc shape", () => {
	it("the folder doc gets @patchwork.title set to the folder name", async () => {
		const named = path.join(work, "my-pushwork-repo");
		await fs.mkdir(named);
		await fs.writeFile(path.join(named, "a.txt"), "a\n");
		await init({ dir: named, shape: "vfs", online: false });
		const doc = await rootDoc<VfsDoc>(named);
		expect(doc["@patchwork"].type).toBe("directory");
		expect(doc["@patchwork"].title).toBe("my-pushwork-repo");
	});

	it("init returns the folder doc URL", async () => {
		await fs.writeFile(path.join(work, "a.txt"), "hi\n");
		const { url, files } = await initVfs();
		expect((await readConfig(work)).rootUrl).toBe(url);
		expect(files).toBe(1);
		expect((await rootDoc<VfsDoc>(work))["@patchwork"].type).toBe("directory");
	});

	it("file content is stored in separate UnixFileEntry docs", async () => {
		await fs.writeFile(path.join(work, "a.txt"), "hello world\n");
		await initVfs();
		await withDocs(work, async docs => {
			const folder = await docs.find<VfsDoc>((await readConfig(work)).rootUrl);
			const file = await docs.find<UnixFileEntry>(folder["a.txt"] as AutomergeUrl);
			expect(file["@patchwork"].type).toBe("file");
			expect(file.content).toBe("hello world\n");
		});
	});

	it("artifact files store ImmutableString content and are pinned", async () => {
		await fs.mkdir(path.join(work, "dist"));
		await fs.writeFile(path.join(work, "dist", "main.js"), "console.log(1)\n");
		await fs.writeFile(path.join(work, "src.ts"), "export {}\n");
		await initVfs();
		await withDocs(work, async docs => {
			const folder = await docs.find<VfsDoc>((await readConfig(work)).rootUrl);
			const artifactUrl = folder["dist/main.js"] as AutomergeUrl;
			const sourceUrl = folder["src.ts"] as AutomergeUrl;
			expect(pinned(artifactUrl)).toBe(true);
			expect(pinned(sourceUrl)).toBe(false);
			expect(isImmutableString((await docs.find<UnixFileEntry>(artifactUrl)).content)).toBe(true);
			expect(typeof (await docs.find<UnixFileEntry>(sourceUrl)).content).toBe("string");
		});
	});

	it(".pushworkattributes overrides the default artifact dirs", async () => {
		await fs.mkdir(path.join(work, "dist"));
		await fs.mkdir(path.join(work, "out"));
		await fs.writeFile(path.join(work, "dist", "main.js"), "console.log(1)\n");
		await fs.writeFile(path.join(work, "out", "bundle.js"), "console.log(2)\n");
		await fs.writeFile(path.join(work, ".pushworkattributes"), "out/**  artifact\ndist/** -artifact\n");
		// the attributes file wins over the passed list
		await initVfs({ artifactDirectories: ["dist"] });
		expect((await readConfig(work)).artifactDirectories).toEqual([]);
		const doc = await rootDoc<VfsDoc>(work);
		expect(pinned(doc["out/bundle.js"] as string)).toBe(true);
		expect(pinned(doc["dist/main.js"] as string)).toBe(false);
	});

	it("patchwork-folder pins artifact-dir folders, not source folders", async () => {
		await fs.mkdir(path.join(work, "dist"));
		await fs.mkdir(path.join(work, "src"));
		await fs.writeFile(path.join(work, "dist", "main.js"), "console.log(1)\n");
		await fs.writeFile(path.join(work, "src", "app.ts"), "export const x = 1\n");
		await init({ dir: work, shape: "patchwork-folder", online: false, artifactDirectories: ["dist"] });
		const { rootUrl } = await readConfig(work);
		expect(pinned(rootUrl)).toBe(false);

		const distId = await withDocs(work, async docs => {
			const root = await docs.find<FolderDoc>(rootUrl);
			const dist = link(root, "dist");
			expect(dist.type).toBe("folder");
			expect(pinned(dist.url)).toBe(true);
			expect(pinned(link(root, "src").url)).toBe(false);
			expect(pinned(link(await docs.find<FolderDoc>(dist.url), "main.js").url)).toBe(true);
			expect(pinned(link(await docs.find<FolderDoc>(link(root, "src").url), "app.ts").url)).toBe(false);
			return parseAutomergeUrl(dist.url).documentId;
		});

		// a later save edits the artifact folder in place rather than recreating it
		await save(work);
		const dist = link(await rootDoc<FolderDoc>(work), "dist");
		expect(parseAutomergeUrl(dist.url).documentId).toBe(distId);
		expect(pinned(dist.url)).toBe(true);
	});

	it("patchwork-folder pins only the configured artifact dir, not its parent", async () => {
		await fs.mkdir(path.join(work, "a", "b"), { recursive: true });
		await fs.writeFile(path.join(work, "a", "b", "x.js"), "x\n");
		await init({ dir: work, shape: "patchwork-folder", online: false, artifactDirectories: ["a/b"] });
		await withDocs(work, async docs => {
			const a = link(await docs.find<FolderDoc>((await readConfig(work)).rootUrl), "a");
			expect(pinned(a.url)).toBe(false);
			expect(pinned(link(await docs.find<FolderDoc>(a.url), "b").url)).toBe(true);
		});
	});

	it("binary files store content as Uint8Array", async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]);
		await fs.writeFile(path.join(work, "img.png"), bytes);
		await initVfs();
		await withDocs(work, async docs => {
			const folder = await docs.find<VfsDoc>((await readConfig(work)).rootUrl);
			const { content } = await docs.find<UnixFileEntry>(folder["img.png"] as AutomergeUrl);
			expect(content).toBeInstanceOf(Uint8Array);
			expect(Array.from(content as Uint8Array)).toEqual(Array.from(bytes));
		});
	});

	it("file URLs stay stable across edits", async () => {
		await fs.writeFile(path.join(work, "stable.txt"), "stable\n");
		await fs.writeFile(path.join(work, "edited.txt"), "v1\n");
		await initVfs();
		const before = await rootDoc<VfsDoc>(work);
		await fs.writeFile(path.join(work, "edited.txt"), "v2\n");
		await save(work);
		const after = await rootDoc<VfsDoc>(work);
		expect(after["stable.txt"]).toBe(before["stable.txt"]);
		expect(after["edited.txt"]).toBe(before["edited.txt"]);
	});

	it("a save with no changes leaves the root doc alone", async () => {
		await fs.writeFile(path.join(work, "a.txt"), "a\n");
		const { url } = await initVfs();
		const heads = () => withDocs(work, docs => docs.heads(url));
		const before = await heads();
		await save(work);
		expect(await heads()).toEqual(before);
	});
});

describe("snarf (cut/paste)", () => {
	const read = (p: string) => fs.readFile(path.join(work, p), "utf8");

	beforeEach(async () => {
		await fs.writeFile(path.join(work, "a.txt"), "a\n");
	});

	it("cut/paste round-trips modifications, additions, and deletions", async () => {
		await fs.writeFile(path.join(work, "mod.txt"), "v1\n");
		await fs.writeFile(path.join(work, "doomed.txt"), "remove me\n");
		await initVfs();
		await fs.writeFile(path.join(work, "mod.txt"), "v2\n");
		await fs.writeFile(path.join(work, "added.txt"), "new\n");
		await fs.unlink(path.join(work, "doomed.txt"));

		const cut = await cutWorkdir(work, { name: "wip" });
		expect(cut.entries).toBe(3);
		expect(await read("mod.txt")).toBe("v1\n");
		expect(await read("doomed.txt")).toBe("remove me\n");
		expect(await exists(path.join(work, "added.txt"))).toBe(false);

		const snarfs = await showSnarfs(work);
		expect(snarfs.map(s => s.name)).toEqual(["wip"]);

		await pasteSnarf(work);
		expect(await read("mod.txt")).toBe("v2\n");
		expect(await read("added.txt")).toBe("new\n");
		expect(await exists(path.join(work, "doomed.txt"))).toBe(false);
		expect(await showSnarfs(work)).toEqual([]);
	});

	it("cut refuses on a clean working tree", async () => {
		await initVfs();
		await expect(cutWorkdir(work)).rejects.toThrow(/working tree clean/);
	});

	it("paste refuses on a dirty working tree", async () => {
		await initVfs();
		await fs.writeFile(path.join(work, "a.txt"), "edited\n");
		await cutWorkdir(work);
		await fs.writeFile(path.join(work, "b.txt"), "extra\n");
		await expect(pasteSnarf(work)).rejects.toThrow(/uncommitted/);
	});

	it("paste with no snarfs errors", async () => {
		await initVfs();
		await expect(pasteSnarf(work)).rejects.toThrow(/no snarfs/);
	});

	it("paste with id selects a specific snarf", async () => {
		await initVfs();
		await fs.writeFile(path.join(work, "first.txt"), "1\n");
		const c1 = await cutWorkdir(work, { name: "first" });
		await fs.writeFile(path.join(work, "second.txt"), "2\n");
		const c2 = await cutWorkdir(work, { name: "second" });

		expect((await pasteSnarf(work, String(c1.id))).id).toBe(c1.id);
		expect(await exists(path.join(work, "first.txt"))).toBe(true);
		expect((await showSnarfs(work)).map(s => s.id)).toEqual([c2.id]);
	});
});

describe("nuclearizeRepo", () => {
	it("regenerates every file URL but keeps the root URL and content", async () => {
		await fs.writeFile(path.join(work, "a.txt"), "A\n");
		await fs.writeFile(path.join(work, "b.txt"), "B\n");
		const { url } = await initVfs();
		const leaves = (doc: VfsDoc) =>
			Object.entries(doc)
				.filter(([k]) => k !== "@patchwork")
				.map(([, v]) => v);
		const before = leaves(await rootDoc<VfsDoc>(work));

		await nuclearizeRepo(work);
		expect((await readConfig(work)).rootUrl).toBe(url);
		const doc = await rootDoc<VfsDoc>(work);
		expect(Object.keys(doc).sort()).toEqual(["@patchwork", "a.txt", "b.txt"]);
		const after = leaves(doc);
		expect(after).toHaveLength(before.length);
		for (const u of after) expect(before).not.toContain(u);
	});
});
