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
// one directory per server under sent/; a short hash keeps urls out of file names
const serverKey = (server: string) => hex(blake3(new TextEncoder().encode(server))).slice(0, 16);
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

// Windows can't open a directory to sync it, and NTFS journals the renames anyway
async function fsyncDir(dir: string) {
	if (process.platform === "win32") return;
	const handle = await fs.open(dir, "r");
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

const gone = Symbol("gone");

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

	// outside trees/, so the layout stays the Rust crate's
	private sentFile(id: SedimentreeId, server: string) {
		return path.join(this.root, "sent", serverKey(server), hex(id.toBytes()));
	}

	// the fragment heads a server is known to hold (see Docs.layout); the first line is the server
	async loadSent(id: SedimentreeId, server: string): Promise<string[]> {
		const text = await fs.readFile(this.sentFile(id, server), "utf8").catch(e => {
			if (e.code === "ENOENT") return "";
			throw e;
		});
		const [from, ...heads] = text.split("\n").filter(Boolean);
		return from === server ? heads.filter(isId) : [];
	}

	async saveSent(id: SedimentreeId, server: string, heads: string[]) {
		const file = this.sentFile(id, server);
		await fs.mkdir(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}-${nonce++}.tmp`;
		await writeSynced(tmp, new TextEncoder().encode([server, ...heads].join("\n") + "\n"));
		await fs.rename(tmp, file);
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
		await fsyncDir(dir);
		await fsyncDir(path.dirname(dir));
	}

	// null when there is no valid item; `gone` when compaction deleted it between the listing and the read
	private async read<T extends Signed>(dir: string, decode: (meta: Uint8Array) => T): Promise<[T, Uint8Array] | null | typeof gone> {
		const found = await stem(dir);
		if (found === undefined) return null;
		const file = path.join(dir, found);
		try {
			const blob = await fs.readFile(`${file}.blob`);
			const signed = verify(dir, decode, await fs.readFile(`${file}.meta`), blob);
			return signed && [signed, blob];
		} catch (e: any) {
			if (e.code === "ENOENT") return gone;
			throw e;
		}
	}

	// only ids with a complete pair: an interrupted write leaves an empty directory behind
	private async listIds(dir: string) {
		const ids = (await names(dir)).filter(isId);
		const complete = await Promise.all(ids.map(async name => (await stem(path.join(dir, name))) !== undefined));
		return ids.filter((_, i) => complete[i]).map(name => CommitId.fromHexString(name));
	}

	private async readAll<T extends Signed>(dir: string, decode: (meta: Uint8Array) => T) {
		const items = await Promise.all((await names(dir)).filter(isId).map(name => this.read(path.join(dir, name), decode)));
		return {
			found: items.filter(item => item !== null && item !== gone),
			vanished: items.includes(gone),
		};
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
		const sent = path.join(this.root, "sent");
		await Promise.all((await names(sent)).map(server => fs.rm(path.join(sent, server, hex(id.toBytes())), { force: true })));
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
		return item && item !== gone ? new CommitWithBlob(...item) : null;
	}

	listCommitIds(id: SedimentreeId) {
		return this.listIds(this.commits(id));
	}

	async loadAllCommits(id: SedimentreeId) {
		return (await this.readAll(this.commits(id), decodeCommit)).found.map(item => new CommitWithBlob(...item));
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
		return item && item !== gone ? new FragmentWithBlob(...item) : null;
	}

	listFragmentIds(id: SedimentreeId) {
		return this.listIds(this.fragments(id));
	}

	async loadAllFragments(id: SedimentreeId) {
		const dir = this.fragments(id);
		let all = await this.readAll(dir, decodeFragment);
		// a fragment only vanishes once compaction has written the one replacing it, so list again
		if (all.vanished) all = await this.readAll(dir, decodeFragment);
		return all.found.map(item => new FragmentWithBlob(...item));
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

// Copy every document of a repo's own store into `to`, and convert its flat sent records
// (sent/<hex id>, the server on the first line) to the per-server layout.
export async function importStore(fromRoot: string, to: FsStorage): Promise<{ docs: number }> {
	const from = await FsStorage.open(fromRoot);
	const ids = await from.loadAllSedimentreeIds();
	for (const id of ids) {
		const [commits, fragments] = await Promise.all([from.loadAllCommits(id), from.loadAllFragments(id)]);
		await to.saveBatchAll(
			id,
			commits.map(c => ({ commitId: c.signed.payload.commitId, signedCommit: c.signed, blob: c.blob })),
			fragments.map(f => ({ fragmentHead: f.signed.payload.head, signedFragment: f.signed, blob: f.blob })),
		);
	}
	const sent = path.join(fromRoot, "sent");
	const entries = await fs.readdir(sent, { withFileTypes: true }).catch(e => {
		if (e.code === "ENOENT") return [];
		throw e;
	});
	for (const entry of entries) {
		// directories are already per-server
		if (!entry.isFile() || !isId(entry.name)) continue;
		const [server, ...heads] = (await fs.readFile(path.join(sent, entry.name), "utf8")).split("\n").filter(Boolean);
		if (server) await to.saveSent(SedimentreeId.fromBytes(new Uint8Array(Buffer.from(entry.name, "hex"))), server, heads.filter(isId));
	}
	return { docs: ids.length };
}
