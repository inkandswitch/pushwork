import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as A from "@automerge/automerge";
import { CommitId, MemorySigner, SedimentreeId, Subduction } from "@automerge/automerge-subduction";
import { FsStorage } from "../../src/storage.js";

// inert until a test arms it: fails the first read of a matching path, like a file compacted away
const vanish = vi.hoisted(() => ({ suffix: null as string | null }));

vi.mock("fs/promises", async importOriginal => {
	const real = await importOriginal<typeof import("fs/promises")>();
	const readFile = ((file: any, ...rest: any[]) => {
		if (vanish.suffix !== null && String(file).endsWith(vanish.suffix)) {
			vanish.suffix = null;
			return Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
		}
		return (real.readFile as any)(file, ...rest);
	}) as typeof real.readFile;
	return { ...real, readFile };
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
	vanish.suffix = null;
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
});
