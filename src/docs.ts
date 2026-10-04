import * as A from "@automerge/automerge";
import {
	BlobMeta,
	CommitId,
	CommitInput,
	Fragment,
	FragmentInput,
	LooseCommit,
	MemoryStorage,
	Subduction,
	SubductionWebSocket,
	setSubductionLogLevel,
	type PeerId,
	type SedimentreeId,
	type SedimentreeStorage,
	type Signer,
} from "@automerge/automerge-subduction";
import { log } from "./log";
import {
	newDocumentId,
	parseAutomergeUrl,
	stringifyAutomergeUrl,
	toSedimentreeId,
	type AutomergeUrl,
	type DocumentId,
} from "./url";

const debug = log("docs");
// for connecting and for each sync round
const TIMEOUT_MS = 10_000;
const SYNC_ROUNDS = 6;
const SEND_SETTLE_MS = 50;

// keyhive only; plain docs store blobs as they are
export type Codec = {
	encode(id: DocumentId, head: string, parents: string[], bytes: Uint8Array): Promise<Uint8Array>;
	decode(id: DocumentId, head: string, bytes: Uint8Array): Promise<Uint8Array | null>;
};

export type DocsOptions = {
	storage: SedimentreeStorage;
	signer: Signer;
	server?: string;
	codec?: Codec;
	newId?: () => Promise<DocumentId>;
};

export type SyncReport = {
	online: boolean;
	error?: string;
	connectMs?: number;
	synced: number;
	unsynced: AutomergeUrl[];
};

type Entry = { doc: A.Doc<unknown>; dirty: boolean; touched: boolean };
type Result = { ok: boolean; received: boolean; error?: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const bare = (id: DocumentId) => stringifyAutomergeUrl(id);

function concat(chunks: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

// runs at most n of the given tasks at once
export function limiter(n: number) {
	let active = 0;
	const queue: (() => void)[] = [];
	return async <T>(task: () => Promise<T>): Promise<T> => {
		if (active < n) active++;
		else await new Promise<void>(resolve => queue.push(resolve));
		try {
			return await task();
		} finally {
			const next = queue.shift();
			if (next) next();
			else active--;
		}
	};
}

type Connection = { peer?: PeerId; error?: string; connectMs?: number };

// The handshake runs off the node, so one that times out leaves the node free to be freed.
async function connect(node: Subduction, signer: Signer, server: string): Promise<Connection> {
	const start = performance.now();
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error(`timed out connecting to ${server}`)), TIMEOUT_MS).unref(),
	);
	try {
		const ws = await Promise.race([SubductionWebSocket.tryDiscover(new URL(server), signer), timeout]);
		const peer = ws.peerId; // toTransport consumes ws
		await node.addConnection(ws.toTransport());
		return { peer, connectMs: Math.round(performance.now() - start) };
	} catch (e) {
		debug("offline: %s", message(e));
		return { error: message(e) };
	}
}

export class Docs {
	private entries = new Map<DocumentId, Entry>();
	private loading = new Map<DocumentId, Promise<Entry>>();
	private results = new Map<DocumentId, Result>();
	private limit = limiter(16);

	private constructor(
		readonly node: Subduction,
		private options: DocsOptions,
		private connection: Connection,
	) {}

	static async open(options: DocsOptions): Promise<Docs> {
		if (!/subduction/.test(process.env.DEBUG ?? "")) setSubductionLogLevel("error");
		const node = new Subduction({ signer: options.signer, storage: options.storage });
		return new Docs(node, options, options.server ? await connect(node, options.signer, options.server) : {});
	}

	/** Automerge's updateText, for use inside `change` by code (such as a custom shape) that can't import pushwork's Automerge. */
	readonly updateText = A.updateText;

	/** Connect to another server, such as a keyhive server, that docs don't sync with. */
	async connect(server: string): Promise<void> {
		const { peer, error } = await connect(this.node, this.options.signer, server);
		if (!peer) throw new Error(`could not connect to ${server}: ${error}`);
	}

	get peer(): PeerId | undefined {
		return this.connection.peer;
	}

	get online(): boolean {
		return this.peer !== undefined;
	}

	async find<T>(url: AutomergeUrl): Promise<A.Doc<T>> {
		const { documentId, heads } = parseAutomergeUrl(url);
		const entry = await this.entry(documentId);
		if (!heads) return entry.doc as A.Doc<T>;
		if (!A.hasHeads(entry.doc, heads) && this.online && !this.results.has(documentId)) {
			await this.syncDoc(documentId);
		}
		if (!A.hasHeads(entry.doc, heads)) throw new Error(`heads not found: ${url}`);
		return A.view(entry.doc, heads) as A.Doc<T>;
	}

	async create<T>(init: T): Promise<AutomergeUrl> {
		const id = (await this.options.newId?.()) ?? newDocumentId();
		const doc = Object.keys(init as object).length
			? A.from(init as Record<string, unknown>)
			: A.emptyChange(A.init());
		this.entries.set(id, { doc, dirty: true, touched: false });
		return bare(id);
	}

	/** Add an empty change to a document, so it has one encrypted under the current keys. */
	async touch(url: AutomergeUrl): Promise<void> {
		const entry = await this.entry(parseAutomergeUrl(url).documentId);
		entry.doc = A.emptyChange(entry.doc);
		entry.dirty = true;
	}

	async change<T>(url: AutomergeUrl, fn: A.ChangeFn<T>): Promise<void> {
		const { documentId, heads } = parseAutomergeUrl(url);
		if (heads) throw new Error(`cannot change a pinned url: ${url}`);
		const entry = await this.entry(documentId);
		const before = A.getHeads(entry.doc).join();
		entry.doc = A.change(entry.doc as A.Doc<T>, fn);
		if (A.getHeads(entry.doc).join() !== before) entry.dirty = true;
	}

	async heads(url: AutomergeUrl): Promise<string[]> {
		return A.getHeads(await this.find(url));
	}

	async pin(url: AutomergeUrl): Promise<AutomergeUrl> {
		const { documentId } = parseAutomergeUrl(url);
		return stringifyAutomergeUrl(documentId, A.getHeads((await this.entry(documentId)).doc));
	}

	urls(): AutomergeUrl[] {
		return [...this.entries.keys()].map(bare);
	}

	async save(): Promise<void> {
		const dirty = [...this.entries].filter(([, e]) => e.dirty);
		await Promise.all(
			dirty.map(([id, entry]) =>
				this.limit(async () => {
					entry.dirty = false;
					entry.touched = true;
					await this.write(id, entry.doc);
				}),
			),
		);
	}

	async sync(urls = this.urls()): Promise<SyncReport> {
		if (!this.online) return this.report();
		await this.save();
		await Promise.all(urls.map(url => this.syncDoc(parseAutomergeUrl(url).documentId)));
		return this.report();
	}

	report(): SyncReport {
		const unsynced = [...this.results].filter(([, r]) => !r.ok).map(([id]) => bare(id));
		return {
			online: this.online,
			error: this.connection.error,
			connectMs: this.connection.connectMs,
			synced: this.results.size - unsynced.length,
			unsynced,
		};
	}

	async close(): Promise<void> {
		await this.save();
		for (const [id, entry] of this.entries) {
			if (entry.touched) await this.compact(id, entry.doc);
		}
		await this.node.disconnectAll();
		this.node.free();
	}

	private entry(id: DocumentId): Promise<Entry> {
		const cached = this.entries.get(id);
		if (cached) return Promise.resolve(cached);
		let pending = this.loading.get(id);
		if (!pending) {
			pending = this.load(id).finally(() => this.loading.delete(id));
			this.loading.set(id, pending);
		}
		return pending;
	}

	private async load(id: DocumentId): Promise<Entry> {
		let doc = await this.read(id);
		if (!doc && this.online) {
			await this.syncDoc(id);
			doc = await this.read(id);
		}
		if (!doc) throw new Error(`document not found: ${bare(id)}`);
		const entry = { doc, dirty: false, touched: this.results.get(id)?.received ?? false };
		this.entries.set(id, entry);
		return entry;
	}

	private async read(id: DocumentId): Promise<A.Doc<unknown> | undefined> {
		const blobs = await this.blobs(id);
		if (!blobs.length) return undefined;
		return A.loadIncremental(A.init(), concat(blobs));
	}

	// read storage directly (not getBlobs) so the codec can see each blob's id
	private async blobs(id: DocumentId): Promise<Uint8Array[]> {
		const sid = toSedimentreeId(id);
		const { storage, codec } = this.options;
		const [commits, fragments] = await Promise.all([storage.loadAllCommits(sid), storage.loadAllFragments(sid)]);
		const items = [
			...commits.map(c => [c.signed.payload.commitId.toHexString(), c.blob] as const),
			...fragments.map(f => [f.signed.payload.head.toHexString(), f.blob] as const),
		];
		if (!codec) return items.map(([, blob]) => blob);
		// Decrypting a blob can reveal its predecessors' keys, and some blobs only open with
		// those (anything encrypted before this reader was given access), so retry the ones
		// that failed for as long as each pass opens more.
		const decoded: (Uint8Array | null)[] = items.map(() => null);
		let pending = items.map((_, i) => i);
		while (pending.length) {
			const results = await Promise.all(pending.map(i => codec.decode(id, items[i][0], items[i][1])));
			const failed = pending.filter((i, k) => (decoded[i] = results[k]) === null);
			if (failed.length === pending.length) break;
			pending = failed;
		}
		return decoded.filter(blob => blob !== null);
	}

	private async onDisk(sid: SedimentreeId) {
		const { storage } = this.options;
		const [commits, fragments] = await Promise.all([storage.listCommitIds(sid), storage.listFragmentIds(sid)]);
		const hex = (ids: CommitId[]) => new Set(ids.map(c => c.toHexString()));
		return { commits, fragments, commitIds: hex(commits), fragmentIds: hex(fragments) };
	}

	private async write(id: DocumentId, doc: A.Doc<unknown>) {
		const sid = toSedimentreeId(id);
		const { commitIds, fragmentIds } = await this.onDisk(sid);
		// Subduction never sends a peer the children of a fragment head it holds (upstream bug),
		// so a fragment that ends at a head is stored as loose commits until the head has children.
		const heads = A.getHeads(doc);
		const atHead = (m: A.FragmentMeta) => heads.includes(m.head);
		const levels = A.getFragmentMetadata(doc, { start: 1 });
		const covered = new Set(levels.filter(m => !atHead(m)).flatMap(m => m.members));
		const deferred = new Set(levels.filter(atHead).flatMap(m => m.members));
		const loose = [...deferred]
			.filter(h => !covered.has(h))
			.map(h => ({ head: h, level: 0, boundary: A.inspectChange(doc, h)!.deps, checkpoints: [], members: [h] }));
		const commits = [...A.getFragmentMetadata(doc, 0), ...loose].filter(m => !commitIds.has(m.head));
		const fragments = levels.filter(m => !atHead(m) && !fragmentIds.has(m.head));
		const encode = async (metas: A.FragmentMeta[]) => {
			const bytes = A.bundleFragmentMetadata(doc, metas);
			const { codec } = this.options;
			if (!codec) return bytes;
			return Promise.all(bytes.map((b, i) => codec.encode(id, metas[i].head, metas[i].boundary, b)));
		};
		const [commitBytes, fragmentBytes] = await Promise.all([encode(commits), encode(fragments)]);
		const cid = (hex: string) => CommitId.fromHexString(hex);
		await this.node.storeBuiltBatch(
			sid,
			commits.map((m, i) => {
				const blob = commitBytes[i];
				return new CommitInput(new LooseCommit(sid, cid(m.head), m.boundary.map(cid), new BlobMeta(blob)), blob);
			}),
			fragments.map((m, i) => {
				const blob = fragmentBytes[i];
				const fragment = new Fragment(sid, cid(m.head), m.boundary.map(cid), m.checkpoints.map(cid), new BlobMeta(blob));
				return new FragmentInput(fragment, blob);
			}),
		);
	}

	// synced means a round where nothing moved either way; a server that keeps asking is refusing our writes.
	// The server only counts a commit as held once its storage write finishes, so it can ask again for
	// what we sent a moment ago; after a round where we only sent, wait (50ms, doubling) before asking.
	private syncDoc(id: DocumentId): Promise<Result> {
		return this.limit(async () => {
			const sid = toSedimentreeId(id);
			let result: Result = { ok: false, received: false };
			let wait = SEND_SETTLE_MS;
			let pulled = false;
			for (let round = 0; round < SYNC_ROUNDS; round++) {
				const r = await this.node.syncWithPeer(this.peer!, sid, false, TIMEOUT_MS);
				if (!r.success) {
					result.error = r.transportErrors[0]?.message ?? "not authorized / not found";
					break;
				}
				result.received ||= r.stats.totalReceived > 0;
				if (r.stats.totalSent === 0 && r.stats.totalReceived === 0) {
					if (!(await this.hasHeads(id, r.stats.remoteHeads))) {
						if (pulled) {
							result.error = "remote heads not found";
							break;
						}
						try {
							await this.pull(id);
						} catch (e) {
							result.error = message(e);
							break;
						}
						pulled = true;
						result.received = true;
						continue;
					}
					result.ok = true;
					break;
				}
				if (r.stats.totalReceived === 0) {
					await new Promise(resolve => setTimeout(resolve, wait));
					wait *= 2;
				}
			}
			if (!result.ok) debug("unsynced %s: %s", bare(id), result.error ?? "server kept requesting");
			const entry = this.entries.get(id);
			if (result.received && entry) {
				entry.doc = A.loadIncremental(entry.doc, concat(await this.blobs(id)));
				entry.touched = true;
			}
			this.results.set(id, result);
			return result;
		});
	}

	// Stored ids answer without decoding; a head inside a fragment needs the doc.
	private async hasHeads(id: DocumentId, heads: CommitId[]): Promise<boolean> {
		const { commitIds, fragmentIds } = await this.onDisk(toSedimentreeId(id));
		const hex = heads.map(h => h.toHexString());
		if (hex.every(h => commitIds.has(h) || fragmentIds.has(h))) return true;
		const doc = await this.read(id);
		return !!doc && A.hasHeads(doc, hex);
	}

	// A shared fragment can hide remote children in Subduction's diff. An empty
	// summary avoids that pruning; import its blobs without losing local changes.
	private async pull(id: DocumentId): Promise<void> {
		const storage: SedimentreeStorage = new MemoryStorage();
		const node = new Subduction({ signer: this.options.signer, storage });
		try {
			const { peer, error } = await connect(node, this.options.signer, this.options.server!);
			if (!peer) throw new Error(error ?? "could not connect");
			const sid = toSedimentreeId(id);
			const r = await node.syncWithPeer(peer, sid, false, TIMEOUT_MS);
			if (!r.success) throw new Error(r.transportErrors[0]?.message ?? "not authorized / not found");
			const [commits, fragments] = await Promise.all([storage.loadAllCommits(sid), storage.loadAllFragments(sid)]);
			await this.options.storage.saveBatchAll(
				sid,
				commits.map(c => ({ commitId: c.signed.payload.commitId, signedCommit: c.signed, blob: c.blob })),
				fragments.map(f => ({ fragmentHead: f.signed.payload.head, signedFragment: f.signed, blob: f.blob })),
			);
		} finally {
			await node.disconnectAll();
			node.free();
		}
	}

	private async compact(id: DocumentId, doc: A.Doc<unknown>) {
		const sid = toSedimentreeId(id);
		const { storage } = this.options;
		const metas = A.getFragmentMetadata(doc);
		const live = new Set(metas.map(m => m.head));
		const { commits, fragments, commitIds, fragmentIds } = await this.onDisk(sid);
		for (const m of metas) if (!(m.level === 0 ? commitIds : fragmentIds).has(m.head)) return;
		const stale = (c: CommitId) => !live.has(c.toHexString()) && A.hasHeads(doc, [c.toHexString()]);
		for (const c of commits) if (stale(c)) await storage.deleteCommit(sid, c);
		for (const f of fragments) if (stale(f)) await storage.deleteFragment(sid, f);
	}
}
