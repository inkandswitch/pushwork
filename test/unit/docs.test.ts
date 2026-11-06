import { describe, it, expect, inject } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as A from "@automerge/automerge";
import { CommitId, MemorySigner, MemoryStorage, type Policy, type SedimentreeStorage } from "@automerge/automerge-subduction";
import { Docs, MissingBase, type DocsOptions } from "../../src/docs.js";
import { FsStorage } from "../../src/storage.js";
import { newDocumentId, parseAutomergeUrl, stringifyAutomergeUrl, toSedimentreeId, type AutomergeUrl } from "../../src/url.js";
import { startServer } from "../server.js";

type Counter = { n: number };

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "pushwork-docs-"));
const open = (o: Partial<DocsOptions> = {}) =>
	Docs.open({ storage: new MemoryStorage(), signer: MemorySigner.generate(), ...o });

async function diskIds(storage: FsStorage, url: AutomergeUrl) {
	const sid = toSedimentreeId(parseAutomergeUrl(url).documentId);
	const ids = [...(await storage.listCommitIds(sid)), ...(await storage.listFragmentIds(sid))];
	return new Set(ids.map(c => c.toHexString()));
}

async function looseIds(storage: FsStorage, url: AutomergeUrl) {
	const sid = toSedimentreeId(parseAutomergeUrl(url).documentId);
	return new Set((await storage.listCommitIds(sid)).map(c => c.toHexString()));
}

const bump = async (docs: Docs, url: AutomergeUrl, times = 16) => {
	for (let i = 0; i < times; i++) {
		await docs.change<Counter>(url, d => {
			d.n++;
		});
	}
};

// Save loose commits until automerge forms a fragment over some of them, so close has
// something to compact. A head that closes a fragment stays loose, and compaction waits for it.
async function headClosesFragment(docs: Docs, url: AutomergeUrl) {
	const doc = await docs.find(url);
	return A.getFragmentMetadata(doc, { start: 1 }).some(m => A.getHeads(doc).includes(m.head));
}

// the heads of fragments that no longer end at the doc's head, which write stores as fragments
async function formedFragments(docs: Docs, url: AutomergeUrl) {
	const doc = await docs.find(url);
	const heads = A.getHeads(doc);
	return A.getFragmentMetadata(doc, { start: 1 }).filter(m => !heads.includes(m.head)).map(m => m.head);
}

async function growFragment(docs: Docs, storage: FsStorage, url: AutomergeUrl) {
	const live = async () => new Set(A.getFragmentMetadata(await docs.find(url)).map(m => m.head));
	while ((await diskIds(storage, url)).size <= (await live()).size || (await headClosesFragment(docs, url))) {
		await bump(docs, url);
		await docs.save();
	}
	return live();
}

describe("Docs offline", () => {
	it("creates, changes, saves and reloads", async () => {
		const dir = await tmp();
		const docs = await open({ storage: await FsStorage.open(dir) });
		expect(docs.online).toBe(false);
		const url = await docs.create<Counter>({ n: 1 });
		await docs.change<Counter>(url, d => {
			d.n = 2;
		});
		const heads = await docs.heads(url);
		expect(docs.urls()).toEqual([url]);
		await docs.close();

		const again = await open({ storage: await FsStorage.open(dir) });
		expect(await again.find<Counter>(url)).toEqual({ n: 2 });
		expect(await again.heads(url)).toEqual(heads);
		await again.close();
	});

	it("creates an empty doc with a change", async () => {
		const docs = await open();
		const url = await docs.create({});
		expect(await docs.heads(url)).toHaveLength(1);
		await docs.close();
	});

	it("finds a pinned url as a view", async () => {
		const docs = await open();
		const url = await docs.create<Counter>({ n: 1 });
		const pinned = await docs.pin(url);
		await docs.change<Counter>(url, d => {
			d.n = 2;
		});
		expect(await docs.find<Counter>(pinned)).toEqual({ n: 1 });
		expect(await docs.find<Counter>(url)).toEqual({ n: 2 });
		await expect(docs.change(pinned, () => {})).rejects.toThrow("pinned");
		await docs.close();
	});

	it("throws on an unknown id", async () => {
		const docs = await open();
		const url = stringifyAutomergeUrl(newDocumentId());
		await expect(docs.find(url)).rejects.toThrow(`document not found: ${url}`);
		await docs.close();
	});

	it("reports offline when the server is unreachable", async () => {
		const docs = await open({ server: "ws://127.0.0.1:1" });
		const report = await docs.sync();
		expect(report.online).toBe(false);
		expect(report.error).toBeTruthy();
		await docs.close();
	});

	it("reloads a doc whose head closes a fragment", async () => {
		const dir = await tmp();
		const docs = await open({ storage: await FsStorage.open(dir) });
		const url = await docs.create<Counter>({ n: 0 });
		while (!(await docs.heads(url))[0].startsWith("00")) {
			await docs.change<Counter>(url, d => {
				d.n++;
			});
		}
		const doc = await docs.find<Counter>(url);
		await docs.close();

		const again = await open({ storage: await FsStorage.open(dir) });
		expect(await again.find<Counter>(url)).toEqual(doc);
		expect(await again.heads(url)).toEqual(A.getHeads(doc));
		await again.close();
	});

	it("compacts absorbed commits at close", async () => {
		const dir = await tmp();
		const storage = await FsStorage.open(dir);
		const docs = await open({ storage });
		const url = await docs.create<Counter>({ n: 0 });
		const live = await growFragment(docs, storage, url);
		const heads = await docs.heads(url);
		await docs.close();

		const reopened = await FsStorage.open(dir);
		expect(await diskIds(reopened, url)).toEqual(live);
		const again = await open({ storage: reopened });
		expect(await again.heads(url)).toEqual(heads);
		await again.close();
	});

	it("stores every fragment's head as a loose commit", async () => {
		const dir = await tmp();
		const storage = await FsStorage.open(dir);
		const docs = await open({ storage });
		const url = await docs.create<Counter>({ n: 0 });
		await growFragment(docs, storage, url);
		const fragments = A.getFragmentMetadata(await docs.find(url), { start: 1 });
		const loose = await looseIds(storage, url);
		for (const m of fragments) expect(loose).toContain(m.head);
		await docs.close();
	});

	it("compacts at close when the head closes a fragment", async () => {
		const dir = await tmp();
		const storage = await FsStorage.open(dir);
		const docs = await open({ storage });
		const url = await docs.create<Counter>({ n: 0 });
		await growFragment(docs, storage, url);
		while (!(await docs.heads(url))[0].startsWith("00")) await bump(docs, url, 1);
		expect(await headClosesFragment(docs, url)).toBe(true);
		const doc = await docs.find<Counter>(url);
		await docs.close();

		const reopened = await FsStorage.open(dir);
		const disk = await diskIds(reopened, url);
		const metas = A.getFragmentMetadata(doc, { start: 1 });
		const fragmentHeads = new Set(metas.map(m => m.head));
		const stored = metas.filter(m => !A.getHeads(doc).includes(m.head));
		expect(stored.length).toBeGreaterThan(0);
		for (const m of stored) {
			for (const h of m.members) if (!fragmentHeads.has(h)) expect(disk).not.toContain(h);
		}
		const again = await open({ storage: reopened });
		expect(await again.find<Counter>(url)).toEqual(doc);
		await again.close();
	});

	it("keeps what it compacted at close and writes only new commits after", async () => {
		const dir = await tmp();
		const docs = await open({ storage: await FsStorage.open(dir) });
		const url = await docs.create<Counter>({ n: 0 });
		await growFragment(docs, await FsStorage.open(dir), url);
		await docs.close();

		const storage = await FsStorage.open(dir);
		const compacted = await diskIds(storage, url);
		const again = await open({ storage });
		await bump(again, url, 1);
		await again.save();
		const [head] = await again.heads(url);
		const written = [...(await diskIds(storage, url))].filter(h => !compacted.has(h));
		expect(written).toEqual([head]);
		await again.close();
	});

	it("keeps a fragment's commits when the fragment's write was interrupted", async () => {
		const dir = await tmp();
		const storage = await FsStorage.open(dir);
		// writes the commits, then dies after creating the fragment's directory
		const crashing: FsStorage = Object.assign(Object.create(storage), {
			async saveBatchAll(...[id, commits, fragments]: Parameters<FsStorage["saveBatchAll"]>) {
				await storage.saveBatchAll(id, commits, []);
				if (!fragments.length) return commits.length;
				const tree = Buffer.from(id.toBytes()).toString("hex");
				for (const f of fragments) {
					const head = f.fragmentHead.toHexString();
					await fs.mkdir(path.join(dir, "trees", tree.slice(0, 4), tree.slice(4), "fragments", head), { recursive: true });
				}
				throw new Error("crash");
			},
		});
		// saving every change puts a fragment's members on disk before the fragment itself
		const first = await open({ storage: crashing });
		const url = await first.create<Counter>({ n: 0 });
		for (;;) {
			await bump(first, url, 1);
			if (await first.save().then(() => false, () => true)) break;
		}

		const second = await open({ storage: await FsStorage.open(dir) });
		await bump(second, url, 1);
		const doc = await second.find<Counter>(url);
		await second.close();

		const third = await open({ storage: await FsStorage.open(dir) });
		expect(await third.find<Counter>(url)).toEqual(doc);
		expect(await third.heads(url)).toEqual(A.getHeads(doc));
		await third.close();
		// a fragment forms on about one change in 256, and every change is saved with fsyncs
	}, 180_000);
});

describe("Docs online", () => {
	it("pushes from one node and pulls from another", async () => {
		const server = inject("server");
		const a = await open({ server });
		expect(a.online).toBe(true);
		const url = await a.create<Counter>({ n: 1 });
		const pushed = await a.sync();
		expect(pushed).toMatchObject({ online: true, synced: 1, unsynced: [] });
		await a.close();

		const b = await open({ server });
		const pulled = await b.sync([url]);
		expect(pulled).toMatchObject({ online: true, synced: 1, unsynced: [] });
		expect(await b.find<Counter>(url)).toEqual({ n: 1 });
		await b.close();
	});

	it("fetches an unknown doc on find and pulls later changes", async () => {
		const server = inject("server");
		const a = await open({ server });
		const url = await a.create<Counter>({ n: 1 });
		await a.sync();

		const b = await open({ server });
		expect(await b.find<Counter>(url)).toEqual({ n: 1 });

		await a.change<Counter>(url, d => {
			d.n = 2;
		});
		expect((await a.sync()).unsynced).toEqual([]);
		await b.sync();
		expect(await b.find<Counter>(url)).toEqual({ n: 2 });

		const missing = stringifyAutomergeUrl(newDocumentId());
		await expect(b.find(missing)).rejects.toThrow("document not found");
		await a.close();
		await b.close();
	});

	it("pulls children of a head that closed a fragment", async () => {
		const server = inject("server");
		const a = await open({ server });
		const url = await a.create<Counter>({ n: 0 });
		while (!(await a.heads(url))[0].startsWith("00")) {
			await a.change<Counter>(url, d => {
				d.n++;
			});
		}
		await a.sync();
		const b = await open({ server });
		await b.find(url);

		await a.change<Counter>(url, d => {
			d.n = -1;
		});
		await a.sync();
		await b.sync();
		expect(await b.find<Counter>(url)).toEqual({ n: -1 });
		await a.close();
		await b.close();
	});

	it.each([1, 3])("converges concurrent edits after shared heads close fragments (%i docs)", async count => {
		const server = inject("server");
		const aStorage: SedimentreeStorage = new MemoryStorage();
		const bStorage: SedimentreeStorage = new MemoryStorage();
		const a = await open({ server, storage: aStorage });
		const urls: AutomergeUrl[] = [];
		for (let i = 0; i < count; i++) {
			const url = await a.create<Counter>({ n: 0 });
			while (!(await a.heads(url))[0].startsWith("00")) {
				await bump(a, url, 1);
			}
			urls.push(url);
		}
		await a.sync();
		const b = await open({ server, storage: bStorage });
		for (const url of urls) {
			await b.find(url);
			await a.change<Counter & { a: string }>(url, d => {
				d.a = "A";
			});
			await b.change<Counter & { b: string }>(url, d => {
				d.b = "B";
			});
		}
		const bHeads = await Promise.all(urls.map(async url => CommitId.fromHexString((await b.heads(url))[0])));
		expect((await a.sync()).unsynced).toEqual([]);
		expect((await b.sync()).unsynced).toEqual([]);
		expect((await a.sync()).unsynced).toEqual([]);
		for (const [i, url] of urls.entries()) {
			expect(await a.find(url)).toEqual(await b.find(url));
			expect(await a.find(url)).toMatchObject({ a: "A", b: "B" });
			const sid = toSedimentreeId(parseAutomergeUrl(url).documentId);
			const original = await bStorage.loadCommit(sid, bHeads[i]);
			expect(original).not.toBeNull();
			expect((await aStorage.loadCommit(sid, bHeads[i]))?.signed.encode()).toEqual(original!.signed.encode());
		}
		await a.close();
		await b.close();
	});

	it("compacts a synced doc and keeps syncing it", async () => {
		const server = inject("server");
		const dir = await tmp();
		const a = await open({ server, storage: await FsStorage.open(dir) });
		const url = await a.create<Counter>({ n: 0 });
		await growFragment(a, await FsStorage.open(dir), url);
		expect((await a.sync()).unsynced).toEqual([]);
		await a.close();

		// a doc received by a sync is compacted too
		const bDir = await tmp();
		const b = await open({ server, storage: await FsStorage.open(bDir) });
		await b.find(url);
		await b.close();

		const again = await open({ server, storage: await FsStorage.open(dir) });
		await bump(again, url);
		expect((await again.sync()).unsynced).toEqual([]);
		const heads = await again.heads(url);
		await again.close();

		const bAgain = await open({ server, storage: await FsStorage.open(bDir) });
		expect((await bAgain.sync([url])).unsynced).toEqual([]);
		expect(await bAgain.heads(url)).toEqual(heads);
		await bAgain.close();

		const fresh = await open({ server });
		expect(await fresh.heads(url)).toEqual(heads);
		await fresh.close();
	});

	it("holds a fragment back until its head has reached the server", async () => {
		const server = inject("server");
		const storage = await FsStorage.open(await tmp());
		const docs = await open({ server, storage });
		const url = await docs.create<Counter>({ n: 0 });
		const sid = toSedimentreeId(parseAutomergeUrl(url).documentId);
		const formed = async () => {
			const doc = await docs.find(url);
			const heads = A.getHeads(doc);
			return A.getFragmentMetadata(doc, { start: 1 }).filter(m => !heads.includes(m.head)).map(m => m.head);
		};
		const fragmentIds = async () => new Set((await storage.listFragmentIds(sid)).map(c => c.toHexString()));
		while (!(await formed()).length) {
			await bump(docs, url);
			await docs.save();
		}
		const heads = await formed();
		for (const h of heads) {
			expect(await looseIds(storage, url)).toContain(h);
			expect(await fragmentIds()).not.toContain(h);
		}
		expect((await docs.sync()).unsynced).toEqual([]);
		for (const h of heads) expect(await fragmentIds()).toContain(h);
		await docs.close();
	});

	// The server sees a fragment cover the commits before it only when the fragment's head
	// reached it first; otherwise it sends compacted commits back on every sync.
	it("gets nothing back when it syncs a compacted doc", async () => {
		const server = inject("server");
		const dir = await tmp();
		const a = await open({ server, storage: await FsStorage.open(dir) });
		const url = await a.create<Counter>({ n: 0 });
		await growFragment(a, await FsStorage.open(dir), url);
		expect((await a.sync()).unsynced).toEqual([]);
		await a.close();

		const storage = await FsStorage.open(dir);
		const compacted = await diskIds(storage, url);
		const again = await open({ server, storage });
		expect((await again.sync([url])).unsynced).toEqual([]);
		expect(await diskIds(storage, url)).toEqual(compacted);
		await again.close();
	});

	it("does not count a head saved during a sync as sent", async () => {
		const server = inject("server");
		const dir = await tmp();
		const a = await open({ server, storage: await FsStorage.open(dir) });
		const url = await a.create<Counter>({ n: 0 });
		expect((await a.sync()).unsynced).toEqual([]);
		// save a new fragment's head right after a quiet round, before sync looks at the disk
		const syncWithPeer = a.node.syncWithPeer.bind(a.node);
		let raced = false;
		a.node.syncWithPeer = async (...args: Parameters<typeof syncWithPeer>) => {
			const r = await syncWithPeer(...args);
			if (!raced && r.success && r.stats.totalSent === 0 && r.stats.totalReceived === 0) {
				raced = true;
				while (!(await formedFragments(a, url)).length) {
					await bump(a, url);
					await a.save();
				}
			}
			return r;
		};
		expect((await a.sync()).unsynced).toEqual([]);
		a.node.syncWithPeer = syncWithPeer;
		expect((await a.sync()).unsynced).toEqual([]);
		await a.close();

		const storage = await FsStorage.open(dir);
		const compacted = await diskIds(storage, url);
		const again = await open({ server, storage });
		expect((await again.sync([url])).unsynced).toEqual([]);
		expect(await diskIds(storage, url)).toEqual(compacted);
		await again.close();
	});

	it("keeps a held fragment's commits on disk when it closes without syncing", async () => {
		const dir = await tmp();
		const docs = await open({ server: "ws://127.0.0.1:1", storage: await FsStorage.open(dir) });
		const url = await docs.create<Counter>({ n: 0 });
		while (!(await formedFragments(docs, url)).length) {
			await bump(docs, url);
			await docs.save();
		}
		const doc = await docs.find<Counter>(url);
		await docs.close();

		const again = await open({ storage: await FsStorage.open(dir) });
		expect(await again.find<Counter>(url)).toEqual(doc);
		expect(await again.heads(url)).toEqual(A.getHeads(doc));
		await again.close();
	});

	it("stores a fragment offline once its head reached the server in an earlier run", async () => {
		const server = await startServer();
		const dir = await tmp();
		const a = await open({ server: server.url, storage: await FsStorage.open(dir) });
		const url = await a.create<Counter>({ n: 0 });
		while (!(await a.heads(url))[0].startsWith("00")) await bump(a, url, 1);
		expect((await a.sync()).unsynced).toEqual([]);
		await a.close();
		await server.close();

		const storage = await FsStorage.open(dir);
		const offline = await open({ server: server.url, storage });
		expect(offline.online).toBe(false);
		await bump(offline, url, 1);
		const formed = await formedFragments(offline, url);
		expect(formed.length).toBeGreaterThan(0);
		await offline.close();
		const sid = toSedimentreeId(parseAutomergeUrl(url).documentId);
		const fragmentIds = new Set((await storage.listFragmentIds(sid)).map(c => c.toHexString()));
		for (const h of formed) expect(fragmentIds).toContain(h);
	});

	it("gives up on a server that stops answering", async () => {
		const server = await startServer();
		const docs = await open({ server: server.url });
		const url = await docs.create<Counter>({ n: 1 });
		server.stall();
		const report = await docs.sync();
		expect(report).toMatchObject({ online: true, synced: 0, unsynced: [url] });
		await docs.close();
		await server.close();
	});

	it("reports pending when the server refuses writes", async () => {
		const deny: Policy = {
			authorizeConnect: async () => {},
			authorizeFetch: async () => {},
			authorizePut: async () => {
				throw new Error("read only");
			},
			filterAuthorizedFetch: async (_peer, ids) => ids,
		};
		const server = await startServer(deny);
		const docs = await open({ server: server.url });
		const url = await docs.create<Counter>({ n: 1 });
		const report = await docs.sync();
		expect(report).toMatchObject({ online: true, synced: 0, unsynced: [url] });
		await docs.close();
		await server.close();
	});

	it("counts a doc synced when its stored blobs cannot be decoded", async () => {
		const server = inject("server");
		const a = await open({ server });
		const url = await a.create<Counter>({ n: 1 });
		await a.sync();
		await a.close();

		const b = await open({
			server,
			codec: {
				encode: async (_id, _head, _parents, bytes) => bytes,
				decode: async () => [],
			},
		});
		expect(await b.sync([url])).toMatchObject({ online: true, synced: 1, unsynced: [] });
		await b.close();
	});
});

describe("Docs base", () => {
	type Doc = { a: number; b?: number };

	// a doc with two changes on disk: h1 sets a to 1, h2 sets it to 2
	async function twoChanges() {
		const dir = await tmp();
		const docs = await open({ storage: await FsStorage.open(dir) });
		const url = await docs.create<Doc>({ a: 0 });
		await docs.change<Doc>(url, d => {
			d.a = 1;
		});
		const h1 = await docs.heads(url);
		await docs.change<Doc>(url, d => {
			d.a = 2;
		});
		const h2 = await docs.heads(url);
		await docs.close();
		const id = parseAutomergeUrl(url).documentId;
		const reopen = async (base?: Map<typeof id, string[]>, o: Partial<DocsOptions> = {}) =>
			open({ storage: await FsStorage.open(dir), base, ...o });
		return { url, id, h1, h2, reopen };
	}

	it("find shows the document at its base", async () => {
		const { url, id, h1, reopen } = await twoChanges();
		const docs = await reopen(new Map([[id, h1]]));
		expect(await docs.find<Doc>(url)).toEqual({ a: 1 });
		expect(await docs.heads(url)).toEqual(h1);
		await docs.close();
	});

	it("change writes at the base and moves it", async () => {
		const { url, id, h1, reopen } = await twoChanges();
		const docs = await reopen(new Map([[id, h1]]));
		await docs.change<Doc>(url, d => {
			d.b = 1;
		});
		expect(await docs.find<Doc>(url)).toEqual({ a: 1, b: 1 });
		const heads = await docs.heads(url);
		expect(heads).toHaveLength(1);
		docs.advance();
		const live = await docs.find<Doc>(url);
		expect(A.inspectChange(live, heads[0])!.deps).toEqual(h1);
		expect(live).toEqual({ a: 2, b: 1 });
		await docs.close();
	});

	it("advance moves every base to live", async () => {
		const { url, id, h1, h2, reopen } = await twoChanges();
		const docs = await reopen(new Map([[id, h1]]));
		await docs.change<Doc>(url, d => {
			d.b = 1;
		});
		const [made] = await docs.heads(url);
		docs.advance();
		expect([...(await docs.heads(url))].sort()).toEqual([made, ...h2].sort());
		await docs.close();

		// documents loaded after advance ignore the base they were given
		const later = await reopen(new Map([[id, h1]]));
		later.advance();
		expect(await later.find<Doc>(url)).toEqual({ a: 2, b: 1 });
		await later.close();
	});

	it("a document missing from the map reads live", async () => {
		const { url, h2, reopen } = await twoChanges();
		const docs = await reopen(new Map());
		expect(await docs.find<Doc>(url)).toEqual({ a: 2 });
		expect(await docs.heads(url)).toEqual(h2);
		await docs.close();
	});

	it("find returns the live document itself when base is live", async () => {
		const { url, id, h2, reopen } = await twoChanges();
		const docs = await reopen(new Map([[id, h2]]));
		const doc = await docs.find<Doc>(url);
		expect(await docs.find<Doc>(url)).toBe(doc);
		const plain = await reopen();
		const live = await plain.find<Doc>(url);
		expect(doc).toEqual(live);
		expect(A.getHeads(doc)).toEqual(A.getHeads(live));
		await plain.close();
		await docs.close();
	});

	it("a missing base head fails offline", async () => {
		const { url, id, reopen } = await twoChanges();
		const docs = await reopen(new Map([[id, ["ab".repeat(32)]]]));
		await expect(docs.find(url)).rejects.toBeInstanceOf(MissingBase);
		await expect(docs.find(url)).rejects.toThrow(/missing from ~\/\.pushwork\/storage/);
		await docs.close();
	});

	it("pin uses the base", async () => {
		const { url, id, h1, reopen } = await twoChanges();
		const docs = await reopen(new Map([[id, h1]]));
		expect(parseAutomergeUrl(await docs.pin(url)).heads).toEqual(h1);
		await docs.close();
	});

	it("touch adds its change at live and leaves the base", async () => {
		const { url, id, h1, h2, reopen } = await twoChanges();
		const docs = await reopen(new Map([[id, h1]]));
		await docs.touch(url);
		expect(await docs.heads(url)).toEqual(h1);
		docs.advance();
		const [touched] = await docs.heads(url);
		expect(A.inspectChange(await docs.find(url), touched)!.deps).toEqual(h2);
		await docs.close();
	});

	it("checkoutHeads reports base, or live heads without one", async () => {
		const { url, id, h1, reopen } = await twoChanges();
		const docs = await reopen(new Map([[id, h1]]));
		await docs.find(url);
		const made = await docs.create<Doc>({ a: 5 });
		const madeId = parseAutomergeUrl(made).documentId;
		expect(docs.checkoutHeads()).toEqual(
			new Map([
				[id, h1],
				[madeId, await docs.heads(made)],
			]),
		);
		docs.advance();
		expect(docs.checkoutHeads().get(id)).toEqual(await docs.heads(url));
		expect(docs.checkoutHeads().get(id)).toHaveLength(1);
		await docs.close();
	});

	it("keeps the base when a sync brings changes in", async () => {
		const server = inject("server");
		const { url, id, h2, reopen } = await twoChanges();
		const pusher = await reopen(undefined, { server });
		expect(await pusher.sync([url])).toMatchObject({ synced: 1, unsynced: [] });
		await pusher.close();

		const other = await open({ server });
		await other.find(url);
		await other.change<Doc>(url, d => {
			d.a = 3;
		});
		await other.sync([url]);
		await other.close();

		const docs = await reopen(new Map([[id, h2]]), { server });
		expect(await docs.find<Doc>(url)).toEqual({ a: 2 });
		expect(await docs.sync([url])).toMatchObject({ synced: 1, unsynced: [] });
		expect(await docs.find<Doc>(url)).toEqual({ a: 2 });
		expect(await docs.heads(url)).toEqual(h2);
		docs.advance();
		expect(await docs.find<Doc>(url)).toEqual({ a: 3 });
		await docs.close();
	});

	// the store has h2, the server a newer change on top (a = 3)
	async function newerOnServer() {
		const server = inject("server");
		const doc = await twoChanges();
		const pusher = await doc.reopen(undefined, { server });
		await pusher.sync([doc.url]);
		await pusher.close();
		const other = await open({ server });
		await other.find(doc.url);
		await other.change<Doc>(doc.url, d => {
			d.a = 3;
		});
		await other.sync([doc.url]);
		await other.close();
		return { ...doc, server };
	}

	it("fresh fetches a document the store already holds before reading it", async () => {
		const { url, reopen, server } = await newerOnServer();
		const stale = await reopen(undefined, { server });
		expect(await stale.find<Doc>(url)).toEqual({ a: 2 });
		await stale.close();
		const docs = await reopen(undefined, { server, fresh: true });
		expect(await docs.find<Doc>(url)).toEqual({ a: 3 });
		expect(docs.report()).toMatchObject({ synced: 1, unsynced: [] });
		await docs.close();
	});

	it("a document first loaded after advance is fetched before it's read", async () => {
		const { url, id, h2, reopen, server } = await newerOnServer();
		const docs = await reopen(new Map([[id, h2]]), { server });
		docs.advance();
		expect(await docs.find<Doc>(url)).toEqual({ a: 3 });
		await docs.close();
	});

	it("fetches a base it doesn't have when online", async () => {
		const server = inject("server");
		const { url, id, reopen } = await twoChanges();
		const pusher = await reopen(undefined, { server });
		await pusher.sync([url]);
		await pusher.close();

		const other = await open({ server });
		await other.find(url);
		await other.change<Doc>(url, d => {
			d.a = 3;
		});
		const h3 = await other.heads(url);
		await other.sync([url]);
		await other.close();

		const docs = await reopen(new Map([[id, h3]]), { server });
		expect(await docs.find<Doc>(url)).toEqual({ a: 3 });
		expect(await docs.heads(url)).toEqual(h3);
		await docs.close();
	});
});
