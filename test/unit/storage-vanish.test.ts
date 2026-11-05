import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as A from "@automerge/automerge";
import { CommitId, MemorySigner, SedimentreeId, Subduction } from "@automerge/automerge-subduction";
import { FsStorage } from "../../src/storage.js";

// inert until a test arms it: fails the first read of a matching path, like a file compacted away
const vanish = vi.hoisted(() => ({
	suffix: null as string | null,
	// when this directory is listed, remove it first (then run `after`), like compaction winning the race
	dir: null as string | null,
	after: null as (() => Promise<void>) | null,
}));

vi.mock("fs/promises", async importOriginal => {
	const real = await importOriginal<typeof import("fs/promises")>();
	const readFile = ((file: any, ...rest: any[]) => {
		if (vanish.suffix !== null && String(file).endsWith(vanish.suffix)) {
			vanish.suffix = null;
			return Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
		}
		return (real.readFile as any)(file, ...rest);
	}) as typeof real.readFile;
	const readdir = (async (dir: any, ...rest: any[]) => {
		if (vanish.dir !== null && String(dir) === vanish.dir) {
			const after = vanish.after;
			vanish.dir = vanish.after = null;
			await real.rm(dir, { recursive: true, force: true });
			await after?.();
		}
		return (real.readdir as any)(dir, ...rest);
	}) as typeof real.readdir;
	return { ...real, readFile, readdir };
});

const seed = crypto.getRandomValues(new Uint8Array(32));
const sid = SedimentreeId.fromBytes(crypto.getRandomValues(new Uint8Array(32)));
let dir: string;
let storage: FsStorage;

const doc = A.change(A.init<any>(), d => {
	d.title = "hello";
});
const other = A.change(A.clone(doc), d => {
	d.n = 1;
});
const change = A.getAllChanges(doc).map(bytes => ({ bytes, ...A.decodeChange(bytes) }))[0];

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-vanish-"));
	storage = await FsStorage.open(dir);
	const node = new Subduction({ signer: MemorySigner.fromBytes(seed), storage });
	await node.storeCommit(sid, CommitId.fromHexString(change.hash), [], change.bytes);
	await node.storeFragment(sid, CommitId.fromHexString(A.getHeads(doc)[0]), [], [], A.save(doc));
	await node.storeFragment(sid, CommitId.fromHexString(A.getHeads(other)[0]), [], [], A.save(other));
	node.free();
});

afterEach(() => {
	vanish.suffix = vanish.dir = vanish.after = null;
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("FsStorage when a blob vanishes", () => {
	it("treats a blob deleted between listing and reading as absent", async () => {
		vanish.suffix = ".blob";
		await storage.deleteAllFragments(sid);
		expect(await storage.loadAllCommits(sid)).toEqual([]);
	});

	it("lists fragments again when one vanishes mid-read", async () => {
		await storage.deleteAllCommits(sid);
		const node = new Subduction({ signer: MemorySigner.fromBytes(seed), storage });
		await node.storeFragment(sid, CommitId.fromHexString(A.getHeads(doc)[0]), [], [], A.save(doc));
		await node.storeFragment(sid, CommitId.fromHexString(A.getHeads(other)[0]), [], [], A.save(other));
		node.free();
		vanish.suffix = ".blob";
		expect(await storage.loadAllFragments(sid)).toHaveLength(2);
	});

	it("lists fragments again when one's whole directory vanishes mid-read", async () => {
		await storage.deleteAllFragments(sid);
		const third = A.change(A.clone(other), d => {
			d.m = 2;
		});
		const node = new Subduction({ signer: MemorySigner.fromBytes(seed), storage });
		await node.storeFragment(sid, CommitId.fromHexString(A.getHeads(doc)[0]), [], [], A.save(doc));
		await node.storeFragment(sid, CommitId.fromHexString(A.getHeads(other)[0]), [], [], A.save(other));
		const bytes = sid.toBytes();
		const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
		const fragments = path.join(dir, "trees", hexOf(bytes.subarray(0, 2)), hexOf(bytes.subarray(2)), "fragments");
		vanish.dir = path.join(fragments, A.getHeads(doc)[0]);
		// compaction removes the listed fragment after writing the one replacing it
		vanish.after = () => node.storeFragment(sid, CommitId.fromHexString(A.getHeads(third)[0]), [], [], A.save(third));
		const loaded = await storage.loadAllFragments(sid);
		node.free();
		expect(loaded).toHaveLength(2);
		expect(loaded.map(f => f.signed.payload.head.toHexString()).sort()).toEqual(
			[A.getHeads(other)[0], A.getHeads(third)[0]].sort(),
		);
	});
});
