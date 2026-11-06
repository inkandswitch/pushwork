import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { MemorySigner, MemoryStorage } from "@automerge/automerge-subduction";
import { Docs, type DocsOptions } from "../../src/docs.js";
import { Hub } from "../../src/hub.js";
import { FsStorage } from "../../src/storage.js";
import type { AutomergeUrl } from "../../src/url.js";
import { startServer } from "../server.js";

type Counter = { n: number };

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-hub-"));
	const signer = MemorySigner.generate();
	const hub = Hub.open(await FsStorage.open(dir), signer);
	const server = await startServer();
	cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
	cleanup.push(() => server.close());
	cleanup.push(() => hub.close());
	const open = (o: Partial<DocsOptions> = {}) => Docs.open({ hub, storage: hub.storage, signer, ...o });
	return { hub, server, signer, open };
}

const bump = async (docs: Docs, url: AutomergeUrl, times: number) => {
	for (let i = 0; i < times; i++) {
		await docs.change<Counter>(url, d => {
			d.n++;
		});
	}
};

async function until(check: () => Promise<boolean>, ms = 2000) {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

describe("Hub", () => {
	it("two Docs on one hub open one connection", async () => {
		const { server, open } = await setup();
		for (let i = 0; i < 2; i++) {
			const docs = await open({ server: server.url });
			expect(docs.online).toBe(true);
			await docs.create<Counter>({ n: i });
			expect(await docs.sync()).toMatchObject({ online: true, unsynced: [] });
			await docs.close();
		}
		expect(server.connections()).toBe(1);
	});

	it("re-dials a server that dropped the connection", async () => {
		const { hub, server, open } = await setup();
		const a = await open({ server: server.url });
		await a.create<Counter>({ n: 1 });
		expect((await a.sync()).unsynced).toEqual([]);
		await a.close();
		const [{ peer }] = await hub.servers();

		await server.node.disconnectAll();
		await until(async () => !(await hub.servers()).some(s => s.peer === peer));

		const b = await open({ server: server.url });
		expect(b.online).toBe(true);
		await b.create<Counter>({ n: 2 });
		expect(await b.sync()).toMatchObject({ online: true, synced: 1, unsynced: [] });
		await b.close();
		expect(server.connections()).toBe(2);
	});

	it("closing Docs leaves the connection open", async () => {
		const { hub, server, open } = await setup();
		const docs = await open({ server: server.url });
		await docs.create<Counter>({ n: 1 });
		await docs.sync();
		await docs.close();
		const servers = await hub.servers();
		expect(servers.map(s => s.server)).toEqual([server.url]);
		expect(servers[0].peer).toMatch(/^[0-9a-f]{64}$/);
	});

	it("writes from one command are sent by the next", async () => {
		const { server, open } = await setup();
		let url: AutomergeUrl | undefined;
		for (let i = 0; i < 12; i++) {
			const online = i % 2 === 1;
			const docs = await open({ server: online ? server.url : undefined });
			url ??= await docs.create<Counter>({ n: 0 });
			await bump(docs, url, 8);
			if (online) expect((await docs.sync()).unsynced).toEqual([]);
			else await docs.save();
			await docs.close();
		}
		const local = await open();
		const expected = (await local.find<Counter>(url!)).n;
		await local.close();
		expect(expected).toBe(96);

		const remote = await Docs.open({ storage: new MemoryStorage(), signer: MemorySigner.generate(), server: server.url });
		expect((await remote.sync([url!])).unsynced).toEqual([]);
		expect((await remote.find<Counter>(url!)).n).toBe(expected);
		await remote.close();
	});

	it("refuses a storage other than the hub's", async () => {
		const { hub, signer } = await setup();
		await expect(Docs.open({ hub, storage: new MemoryStorage(), signer })).rejects.toThrow();
	});
});
