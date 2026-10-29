import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MemorySigner, MemoryStorage } from "@automerge/automerge-subduction";
import { CiphertextStore, Keyhive, Signer } from "@keyhive/keyhive";
import { Docs } from "../../src/docs";
import { cardPeerId, openHive, resolveSettings } from "../../src/keyhive";
import { type Message, decodeMessage, decodeSigned, encodeMessage, encodeSigned } from "../../src/keyhive/keyline/wire";
import { fetchCard } from "../../src/keyhive/keyline";
import { parseAutomergeUrl } from "../../src/url";
import { keylineServerBinary, startKeylineServer } from "../keyline-server";

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);
const archive = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-keyline-")), "archive");
const seed = () => crypto.getRandomValues(new Uint8Array(32));

// a card for a server that is never contacted
async function offlineCard(): Promise<string> {
	const kh = await Keyhive.init(Signer.generateMemory(), CiphertextStore.newInMemory(), () => {});
	return Buffer.from((await kh.contactCard()).toBytes()).toString("base64");
}

describe("keyline wire", () => {
	const messages: Message[] = [
		{ type: "SyncRequest", found: [bytes(32, 1), bytes(32, 2)], pending: [] },
		{ type: "SyncResponse", requested: [bytes(32, 3)], found: [bytes(7, 4)], responderTotal: 5, requesterTotal: 2 },
		{ type: "SyncOps", ops: [bytes(9, 5), bytes(0, 0)], responderTotal: 0, requesterTotal: 2 ** 40 },
		{ type: "RequestContactCard" },
		{ type: "MissingContactCard" },
		{ type: "SyncCheck", senderTotal: 3, senderSyncpoint: 2, senderDigest: bytes(32, 9) },
		{ type: "SyncConfirmation", confirmerTotal: 12 },
	];

	for (const message of messages) {
		it(`round-trips ${message.type}`, () => {
			const addressed = { sender: bytes(32, 0xaa), target: bytes(32, 0xbb), message };
			expect(decodeMessage(encodeMessage(addressed))).toEqual(addressed);
		});
	}

	it("round-trips a signed message, with and without a card", () => {
		expect(decodeSigned(encodeSigned({ signed: bytes(4, 1) }))).toEqual({ signed: bytes(4, 1), contactCard: undefined });
		const withCard = { signed: bytes(4, 1), contactCard: bytes(3, 2) };
		expect(decodeSigned(encodeSigned(withCard))).toEqual(withCard);
	});

	it("rejects a malformed peer id", () => {
		const bad = encodeMessage({ sender: bytes(31, 1), target: bytes(32, 2), message: { type: "RequestContactCard" } });
		expect(() => decodeMessage(bad)).toThrow(/sender_id/);
	});
});

describe("keyline hive", () => {
	it("encrypts on save and decrypts after reopening the archive", async () => {
		const file = archive();
		const key = seed();
		const settings = { server: "ws://127.0.0.1:9", card: await offlineCard() };
		const storage = new MemoryStorage();
		const hive = await openHive(file, key, settings, false, "keyline");
		const group = await hive.createGroup({ server: "relay" });
		const docs = await Docs.open({ storage, signer: MemorySigner.fromBytes(key), codec: hive.codec, newId: hive.newId(group) });
		const url = await docs.create({ text: "secret" });
		for (const text of ["one", "two", "three"]) {
			await docs.change<{ text: string }>(url, d => {
				d.text = text;
			});
		}
		await docs.close();
		await hive.close();

		const plain = await Docs.open({ storage, signer: MemorySigner.fromBytes(key) });
		await expect(plain.find(url)).rejects.toThrow();
		await plain.close();

		const reopened = await openHive(file, key, settings, false, "keyline");
		const { documentId } = parseAutomergeUrl(url);
		expect(await reopened.canWrite(documentId)).toBe(true);
		expect(await reopened.groupOf(documentId)).toBe(group);
		const again = await Docs.open({ storage, signer: MemorySigner.fromBytes(key), codec: reopened.codec });
		expect((await again.find<{ text: string }>(url)).text).toBe("three");
		await again.close();
		await reopened.close();
	});

	it("sets and revokes access on a group, but has no public access", async () => {
		const settings = { server: "ws://127.0.0.1:9", card: await offlineCard() };
		const hive = await openHive(archive(), seed(), settings, false, "keyline");
		const other = await openHive(archive(), seed(), settings, false, "keyline");
		const group = await hive.createGroup({ server: "relay" });
		const id = await hive.newId(group)();
		expect(await hive.groupDocs(group)).toEqual([id]);
		const card = await other.contactCard();
		expect(cardPeerId(card)).toBe(other.id);
		const access = async (who: string) => (await hive.members(group)).find(m => m.id === who)?.access;
		await hive.setAccess(group, { card }, "read");
		expect(await access(other.id)).toBe("read");
		await hive.setAccess(group, { card }, "edit");
		expect(await access(other.id)).toBe("edit");
		await hive.setAccess(group, { card }, "none");
		expect(await access(other.id)).toBeUndefined();
		await expect(hive.setAccess(group, { public: true }, "read")).rejects.toThrow(/no public access/);
		await expect(hive.createGroup({ public: "read", server: "relay" })).rejects.toThrow(/no public access/);
		await hive.close();
		await other.close();
	});

	it("ignores an ARK card left in the shared settings", () => {
		expect(() => resolveSettings({ server: "ws://127.0.0.1:9", card: '{"not":"base64"}', version: "keyline" })).toThrow(
			/no contact card/,
		);
	});
});

// against subduction_cli from subduction's keyline branch
describe.skipIf(!keylineServerBinary)("keyline sync", () => {
	let server: Awaited<ReturnType<typeof startKeylineServer>>;
	beforeAll(async () => {
		server = await startKeylineServer();
	});
	afterAll(() => server?.close());

	it("fetches the server's own card", async () => {
		const card = await fetchCard(server.url);
		const docs = await Docs.open({ storage: new MemoryStorage(), signer: MemorySigner.generate(), server: server.url });
		expect(cardPeerId(card)).toBe(Buffer.from(docs.peer!.toBytes()).toString("base64"));
		await docs.close();
	});

	it("lets a reader added later read what was written before", async () => {
		const settings = { server: server.url, card: await fetchCard(server.url) };
		const open = async (key: Uint8Array, hive: Awaited<ReturnType<typeof openHive>>, group?: string) => {
			const docs = await Docs.open({
				storage: new MemoryStorage(),
				signer: MemorySigner.fromBytes(key),
				server: server.url,
				codec: hive.codec,
				newId: group ? hive.newId(group) : undefined,
			});
			await hive.sync(docs);
			return docs;
		};

		const aliceKey = seed();
		const alice = await openHive(archive(), aliceKey, settings, false, "keyline");
		const group = await alice.createGroup({ server: "relay" });
		const aliceDocs = await open(aliceKey, alice, group);
		const url = await aliceDocs.create({ text: "before" });
		await aliceDocs.change<{ text: string }>(url, d => {
			d.text = "still before";
		});
		await alice.sync(aliceDocs);
		expect(await aliceDocs.sync([url])).toMatchObject({ synced: 1, unsynced: [] });

		const bobKey = seed();
		const bob = await openHive(archive(), bobKey, settings, false, "keyline");
		await alice.setAccess(group, { card: await bob.contactCard() }, "read");
		await alice.sync(aliceDocs);

		const bobDocs = await open(bobKey, bob);
		const { documentId } = parseAutomergeUrl(url);
		expect(await bob.groupOf(documentId)).toBe(group);
		expect(await bob.canWrite(documentId)).toBe(false);
		await bobDocs.sync([url]);
		expect((await bobDocs.find<{ text: string }>(url)).text).toBe("still before");

		await Promise.all([aliceDocs.close(), bobDocs.close()]);
		await Promise.all([alice.close(), bob.close()]);
	});
});
