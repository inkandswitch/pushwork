// SedimentreeStorage in the on-disk layout of the Rust crate sedimentree_fs_storage 0.12.2:
//   root/trees/{hex id[0..2]}/{hex id[2..32]}/{commits|fragments}/{hex id}/{hex digest}.meta|.blob
import * as fs from "fs/promises";
import * as path from "path";
import { blake3 } from "@noble/hashes/blake3.js";
import {
	BlobMeta,
	CommitId,
	CommitWithBlob,
	FragmentWithBlob,
	SedimentreeId,
	SignedFragment,
	SignedLooseCommit,
	type SedimentreeStorage,
} from "@automerge/automerge-subduction";
import { log } from "./log";

const debug = log("storage");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const isId = (name: string) => /^[0-9a-f]{64}$/.test(name);

// Signed<T> is schema(4) | issuer(32) | fields | signature(64); files are named by blake3(schema | fields)
function payloadDigest(signed: Uint8Array): string {
	const payload = new Uint8Array(signed.length - 96);
	payload.set(signed.subarray(0, 4));
	payload.set(signed.subarray(36, signed.length - 64), 4);
	return hex(blake3(payload));
}

async function names(dir: string): Promise<string[]> {
	return fs.readdir(dir).catch(e => {
		if (e.code === "ENOENT") return [];
		throw e;
	});
}

async function size(file: string): Promise<number> {
	return fs.stat(file).then(
		s => s.size,
		e => {
			if (e.code === "ENOENT") return -1;
			throw e;
		},
	);
}

async function fsync(file: string) {
	const handle = await fs.open(file, "r");
	await handle.sync().finally(() => handle.close());
}

async function writeSynced(file: string, data: Uint8Array) {
	const handle = await fs.open(file, "w");
	await handle
		.writeFile(data)
		.then(() => handle.sync())
		.finally(() => handle.close());
}

// the smallest stem with both a .meta and a .blob
async function stem(dir: string): Promise<string | undefined> {
	const files = await names(dir);
	return files
		.filter(f => f.endsWith(".meta") && files.includes(f.slice(0, -5) + ".blob"))
		.map(f => f.slice(0, -5))
		.sort()[0];
}

type Signed = SignedLooseCommit | SignedFragment;

// like the Rust crate, skip an item whose meta doesn't decode or whose blob doesn't match it
function verify<T extends Signed>(dir: string, decode: (meta: Uint8Array) => T, meta: Uint8Array, blob: Uint8Array): T | null {
	let signed: T;
	let want: BlobMeta;
	try {
		signed = decode(meta);
		want = signed.payload.blobMeta;
	} catch (e) {
		debug("skipping %s: %s", dir, e);
		return null;
	}
	const got = new BlobMeta(blob);
	if (want.sizeBytes === got.sizeBytes && want.digest().toHexString() === got.digest().toHexString()) return signed;
	debug("skipping %s: blob does not match its meta", dir);
	return null;
}

const decodeCommit = (meta: Uint8Array) => SignedLooseCommit.tryDecode(meta);
const decodeFragment = (meta: Uint8Array) => SignedFragment.tryDecode(meta);

let nonce = 0;

export class FsStorage implements SedimentreeStorage {
	private constructor(readonly root: string) {}

	static async open(root: string): Promise<FsStorage> {
		await fs.mkdir(path.join(root, "trees"), { recursive: true });
		return new FsStorage(root);
	}

	private tree(id: SedimentreeId) {
		const bytes = id.toBytes();
		return path.join(this.root, "trees", hex(bytes.subarray(0, 2)), hex(bytes.subarray(2)));
	}

	private commits(id: SedimentreeId) {
		return path.join(this.tree(id), "commits");
	}

	private fragments(id: SedimentreeId) {
		return path.join(this.tree(id), "fragments");
	}

	// the blob is renamed into place before the meta: a .meta means the pair is complete
	private async writePair(dir: string, meta: Uint8Array, blob: Uint8Array) {
		const file = path.join(dir, payloadDigest(meta));
		if ((await size(`${file}.meta`)) === meta.length && (await size(`${file}.blob`)) === blob.length) return;
		await fs.mkdir(dir, { recursive: true });
		const tmp = `${file}.${process.pid}-${nonce++}`;
		await writeSynced(`${tmp}.blob.tmp`, blob);
		await writeSynced(`${tmp}.meta.tmp`, meta);
		await fs.rename(`${tmp}.blob.tmp`, `${file}.blob`);
		await fs.rename(`${tmp}.meta.tmp`, `${file}.meta`);
		await fsync(dir);
		await fsync(path.dirname(dir));
	}

	private async read<T extends Signed>(dir: string, decode: (meta: Uint8Array) => T): Promise<[T, Uint8Array] | null> {
		const found = await stem(dir);
		if (found === undefined) return null;
		const file = path.join(dir, found);
		const blob = await fs.readFile(`${file}.blob`);
		const signed = verify(dir, decode, await fs.readFile(`${file}.meta`), blob);
		return signed && [signed, blob];
	}

	// only ids with a complete pair: an interrupted write leaves an empty directory behind
	private async listIds(dir: string) {
		const ids = (await names(dir)).filter(isId);
		const complete = await Promise.all(ids.map(async name => (await stem(path.join(dir, name))) !== undefined));
		return ids.filter((_, i) => complete[i]).map(name => CommitId.fromHexString(name));
	}

	private async readAll<T extends Signed>(dir: string, decode: (meta: Uint8Array) => T) {
		const items = await Promise.all((await names(dir)).filter(isId).map(name => this.read(path.join(dir, name), decode)));
		return items.filter(item => item !== null);
	}

	private async clear(dir: string) {
		await fs.rm(dir, { recursive: true, force: true });
		await fs.mkdir(dir, { recursive: true });
	}

	async saveSedimentreeId(id: SedimentreeId) {
		await fs.mkdir(this.commits(id), { recursive: true });
		await fs.mkdir(this.fragments(id), { recursive: true });
	}

	async deleteSedimentreeId(id: SedimentreeId) {
		await fs.rm(this.tree(id), { recursive: true, force: true });
	}

	async containsSedimentreeId(id: SedimentreeId) {
		return (await size(this.tree(id))) >= 0;
	}

	async loadAllSedimentreeIds() {
		const trees = path.join(this.root, "trees");
		const ids: SedimentreeId[] = [];
		for (const bucket of await names(trees)) {
			for (const leaf of await names(path.join(trees, bucket))) {
				if (isId(bucket + leaf)) ids.push(SedimentreeId.fromBytes(new Uint8Array(Buffer.from(bucket + leaf, "hex"))));
			}
		}
		return ids;
	}

	async saveCommit(id: SedimentreeId, commitId: CommitId, signed: SignedLooseCommit, blob: Uint8Array) {
		const meta = signed.encode();
		await this.writePair(path.join(this.commits(id), commitId.toHexString()), meta, blob.slice());
		await this.saveSedimentreeId(id);
	}

	async loadCommit(id: SedimentreeId, commitId: CommitId) {
		const item = await this.read(path.join(this.commits(id), commitId.toHexString()), decodeCommit);
		return item && new CommitWithBlob(...item);
	}

	listCommitIds(id: SedimentreeId) {
		return this.listIds(this.commits(id));
	}

	async loadAllCommits(id: SedimentreeId) {
		return (await this.readAll(this.commits(id), decodeCommit)).map(item => new CommitWithBlob(...item));
	}

	async deleteCommit(id: SedimentreeId, commitId: CommitId) {
		await fs.rm(path.join(this.commits(id), commitId.toHexString()), { recursive: true, force: true });
	}

	deleteAllCommits(id: SedimentreeId) {
		return this.clear(this.commits(id));
	}

	async saveFragment(id: SedimentreeId, head: CommitId, signed: SignedFragment, blob: Uint8Array) {
		const meta = signed.encode();
		await this.writePair(path.join(this.fragments(id), head.toHexString()), meta, blob.slice());
		await this.saveSedimentreeId(id);
	}

	async loadFragment(id: SedimentreeId, head: CommitId) {
		const item = await this.read(path.join(this.fragments(id), head.toHexString()), decodeFragment);
		return item && new FragmentWithBlob(...item);
	}

	listFragmentIds(id: SedimentreeId) {
		return this.listIds(this.fragments(id));
	}

	async loadAllFragments(id: SedimentreeId) {
		return (await this.readAll(this.fragments(id), decodeFragment)).map(item => new FragmentWithBlob(...item));
	}

	async deleteFragment(id: SedimentreeId, head: CommitId) {
		await fs.rm(path.join(this.fragments(id), head.toHexString()), { recursive: true, force: true });
	}

	deleteAllFragments(id: SedimentreeId) {
		return this.clear(this.fragments(id));
	}

	async saveBatchAll(
		id: SedimentreeId,
		commits: Array<{ commitId: CommitId; signedCommit: SignedLooseCommit; blob: Uint8Array }>,
		fragments: Array<{ fragmentHead: CommitId; signedFragment: SignedFragment; blob: Uint8Array }>,
	) {
		// copy out of wasm memory before the first await
		const items = [
			...commits.map(c => [path.join(this.commits(id), c.commitId.toHexString()), c.signedCommit.encode(), c.blob.slice()] as const),
			...fragments.map(f => [path.join(this.fragments(id), f.fragmentHead.toHexString()), f.signedFragment.encode(), f.blob.slice()] as const),
		];
		await Promise.all(items.map(([dir, meta, blob]) => this.writePair(dir, meta, blob)));
		await this.saveSedimentreeId(id);
		return items.length;
	}
}
