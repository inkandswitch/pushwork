import { describe, it, expect, inject } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as A from "@automerge/automerge";
import { CommitId, MemorySigner, MemoryStorage, type Policy, type SedimentreeStorage } from "@automerge/automerge-subduction";
import { Docs, type DocsOptions } from "../../src/docs.js";
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

const bump = async (docs: Docs, url: AutomergeUrl, times = 16) => {
	for (let i = 0; i < times; i++) {
		await docs.change<Counter>(url, d => {
			d.n++;
		});
	}
};

// Save loose commits until automerge forms a fragment over some of them, so close has
// something to compact. A head that closes a fragment stays loose, and compaction waits for it.
async function growFragment(docs: Docs, storage: FsStorage, url: AutomergeUrl) {
	const live = async () => new Set(A.getFragmentMetadata(await docs.find(url)).map(m => m.head));
	const headClosesFragment = async () => {
		const doc = await docs.find(url);
		return A.getFragmentMetadata(doc, { start: 1 }).some(m => A.getHeads(doc).includes(m.head));
	};
	while ((await diskIds(storage, url)).size <= (await live()).size || (await headClosesFragment())) {
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
				decode: async () => null,
			},
		});
		expect(await b.sync([url])).toMatchObject({ online: true, synced: 1, unsynced: [] });
		await b.close();
	});
});
