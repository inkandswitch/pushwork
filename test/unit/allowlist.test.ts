import { describe, it, expect } from "vitest";
import { BlobMeta, CommitId, MemorySigner, MemoryStorage, SedimentreeId } from "@automerge/automerge-subduction";
import { Docs, type DocsOptions } from "../../src/docs.js";
import { parseAutomergeUrl, toSedimentreeId } from "../../src/url.js";
import { startServer } from "../server.js";

const open = (o: Partial<DocsOptions> = {}) =>
	Docs.open({ storage: new MemoryStorage(), signer: MemorySigner.generate(), ...o });

describe("server isolation", () => {
	it("still syncs documents with the server it started syncing them with", async () => {
		const server = await startServer();
		const docs = await open({ server: server.url });
		await docs.create({ n: 1 });
		expect(await docs.sync()).toMatchObject({ online: true, synced: 1, unsynced: [] });
		await docs.close();
		await server.close();
	});

	it("doesn't let another connected server fetch a document", async () => {
		const x = await startServer();
		const y = await startServer();
		const docs = await open({ server: x.url });
		await docs.connect(y.url);
		const url = await docs.create({ secret: true });
		await docs.sync();
		const id = toSedimentreeId(parseAutomergeUrl(url).documentId);
		const [client] = await y.node.getConnectedPeerIds();
		await y.node.syncWithPeer(client, id, false, 5_000).catch(() => {});
		expect((await y.node.getCommits(id)) ?? []).toHaveLength(0);
		await docs.close();
		await x.close();
		await y.close();
	});

	it("refuses a document a server pushes without being asked", async () => {
		const storage = new MemoryStorage();
		const y = await startServer();
		const docs = await open({ server: y.url, storage });
		const stray = SedimentreeId.fromBytes(new Uint8Array(32).fill(7));
		const blob = new Uint8Array([1, 2, 3]);
		await y.node.addCommit(stray, CommitId.fromBytes(new Uint8Array(32).fill(9)), [], blob);
		expect(await y.node.getCommits(stray)).toHaveLength(1);
		const [client] = await y.node.getConnectedPeerIds();
		await y.node.syncWithPeer(client, stray, false, 5_000).catch(() => {});
		expect(await storage.loadAllCommits(stray)).toHaveLength(0);
		await docs.close();
		await y.close();
	});
});
