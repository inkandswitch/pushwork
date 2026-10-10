import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as A from "@automerge/automerge";
import { blake3 } from "@noble/hashes/blake3.js";
import {
	CommitId,
	MemorySigner,
	SedimentreeId,
	SignedLooseCommit,
	Subduction,
} from "@automerge/automerge-subduction";
import { FsStorage } from "../../src/storage.js";

let root: string;
const seed = crypto.getRandomValues(new Uint8Array(32));
const idBytes = crypto.getRandomValues(new Uint8Array(32));
const sid = () => SedimentreeId.fromBytes(idBytes);
const tree = () =>
	path.join("trees", Buffer.from(idBytes.subarray(0, 2)).toString("hex"), Buffer.from(idBytes.subarray(2)).toString("hex"));

// an initial change, two concurrent edits and a merge
let doc = A.change(A.init<any>(), d => {
	d.title = "hello";
});
const a = A.change(A.clone(doc), d => {
	d.a = 1;
});
const b = A.change(A.clone(doc), d => {
	d.b = 2;
});
doc = A.change(A.merge(a, b), d => {
	d.c = 3;
});
const changes = A.getAllChanges(doc).map(bytes => ({ bytes, ...A.decodeChange(bytes) }));

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const e of await fs.readdir(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		out.push(...(e.isDirectory() ? await walk(p) : [path.relative(root, p)]));
	}
	return out.sort();
}

async function store(storage: FsStorage) {
	const node = new Subduction({ signer: MemorySigner.fromBytes(seed), storage });
	for (const c of changes) {
		await node.storeCommit(sid(), CommitId.fromHexString(c.hash), c.deps.map(d => CommitId.fromHexString(d)), c.bytes);
	}
	await node.storeFragment(sid(), CommitId.fromHexString(A.getHeads(doc)[0]), [], [], A.save(doc));
	node.free();
}

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-storage-"));
	await store(await FsStorage.open(root));
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("FsStorage", () => {
	it("writes the sedimentree_fs_storage layout", async () => {
		const files = await walk(root);
		for (const c of changes) {
			const metas = files.filter(f => f.startsWith(path.join(tree(), "commits", c.hash)) && f.endsWith(".meta"));
			expect(metas).toHaveLength(1);
			const meta = await fs.readFile(path.join(root, metas[0]));
			const blob = await fs.readFile(path.join(root, metas[0].replace(/\.meta$/, ".blob")));
			expect(new Uint8Array(blob)).toEqual(c.bytes);
			expect(meta.subarray(0, 4).toString("latin1")).toBe("STC\0");
			const payload = Buffer.concat([meta.subarray(0, 4), meta.subarray(36, meta.length - 64)]);
			const digest = Buffer.from(blake3(payload)).toString("hex");
			expect(path.basename(metas[0])).toBe(`${digest}.meta`);
			expect(SignedLooseCommit.tryDecode(meta).payload.digest.toHexString()).toBe(digest);
		}
		expect(files.filter(f => f.includes(`${path.sep}fragments${path.sep}`) && f.endsWith(".meta"))).toHaveLength(1);
		expect(files.some(f => f.endsWith(".tmp"))).toBe(false);
	});

	it("reads back after reopening", async () => {
		const storage = await FsStorage.open(root);
		const ids = await storage.loadAllSedimentreeIds();
		expect(ids.map(id => Buffer.from(id.toBytes()).toString("hex"))).toEqual([Buffer.from(idBytes).toString("hex")]);
		expect(await storage.containsSedimentreeId(sid())).toBe(true);
		expect(await storage.listCommitIds(sid())).toHaveLength(changes.length);
		expect(await storage.loadAllCommits(sid())).toHaveLength(changes.length);
		expect(await storage.loadAllFragments(sid())).toHaveLength(1);
		const commit = await storage.loadCommit(sid(), CommitId.fromHexString(changes[0].hash));
		expect(commit).not.toBeNull();
	});

	it("serves the doc to a fresh Subduction", async () => {
		const node = new Subduction({ signer: MemorySigner.fromBytes(seed), storage: await FsStorage.open(root) });
		expect(await node.sedimentreeIds()).toHaveLength(1);
		const blobs = await node.getBlobs(sid());
		const rebuilt = A.loadIncremental(A.init<any>(), Buffer.concat(blobs));
		expect(A.toJS(rebuilt)).toEqual({ title: "hello", a: 1, b: 2, c: 3 });
		node.free();
	});

	it("re-storing is a no-op", async () => {
		const before = await walk(root);
		await store(await FsStorage.open(root));
		expect(await walk(root)).toEqual(before);
	});

	it("ignores .tmp files and incomplete pairs", async () => {
		const storage = await FsStorage.open(root);
		const dir = path.join(root, tree(), "commits", changes[0].hash);
		await fs.writeFile(path.join(dir, `${"0".repeat(64)}.1-0.meta.tmp`), "junk");
		await fs.writeFile(path.join(dir, `${"0".repeat(64)}.blob`), "junk");
		const commit = await storage.loadCommit(sid(), CommitId.fromHexString(changes[0].hash));
		expect(commit!.blob).toEqual(changes[0].bytes);
		expect(await storage.listCommitIds(sid())).toHaveLength(changes.length);
	});

	it("doesn't list an item whose write was interrupted", async () => {
		const storage = await FsStorage.open(root);
		const dir = path.join(root, tree(), "fragments", "a".repeat(64));
		await fs.mkdir(dir);
		await fs.writeFile(path.join(dir, `${"0".repeat(64)}.1-0.blob.tmp`), "junk");
		expect(await storage.listFragmentIds(sid())).toHaveLength(1);
		expect(await storage.loadFragment(sid(), CommitId.fromHexString("a".repeat(64)))).toBeNull();
		await fs.rm(dir, { recursive: true });
	});

	it("skips items that don't decode or don't match their blob", async () => {
		const storage = await FsStorage.open(root);
		const commits = path.join(root, tree(), "commits");
		const good = path.join(commits, changes[0].hash);
		const meta = (await fs.readdir(good)).find(f => f.endsWith(".meta"))!;
		const junk = path.join(commits, "b".repeat(64));
		const swapped = path.join(commits, "c".repeat(64));
		await fs.mkdir(junk);
		await fs.writeFile(path.join(junk, `${"0".repeat(64)}.meta`), "junk");
		await fs.writeFile(path.join(junk, `${"0".repeat(64)}.blob`), "junk");
		await fs.mkdir(swapped);
		await fs.copyFile(path.join(good, meta), path.join(swapped, meta));
		await fs.writeFile(path.join(swapped, meta.replace(/\.meta$/, ".blob")), "not the blob");
		expect(await storage.loadAllCommits(sid())).toHaveLength(changes.length);
		expect(await storage.loadCommit(sid(), CommitId.fromHexString("c".repeat(64)))).toBeNull();
		await fs.rm(junk, { recursive: true });
		await fs.rm(swapped, { recursive: true });
	});

	it("deletes", async () => {
		const storage = await FsStorage.open(root);
		await storage.deleteCommit(sid(), CommitId.fromHexString(changes[0].hash));
		expect(await storage.loadCommit(sid(), CommitId.fromHexString(changes[0].hash))).toBeNull();
		expect(await storage.listCommitIds(sid())).toHaveLength(changes.length - 1);
		await storage.deleteAllCommits(sid());
		expect(await storage.listCommitIds(sid())).toHaveLength(0);
		await storage.deleteAllFragments(sid());
		expect(await storage.loadAllFragments(sid())).toHaveLength(0);
		await storage.deleteSedimentreeId(sid());
		expect(await storage.containsSedimentreeId(sid())).toBe(false);
		expect(await storage.loadAllSedimentreeIds()).toHaveLength(0);
	});
});
