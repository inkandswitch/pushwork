import * as fs from "fs/promises";
import bs58check from "bs58check";
import {
	Access,
	Archive,
	ChangeId,
	CiphertextStore,
	ContactCard,
	DocumentId as KeyhiveDocumentId,
	GroupId,
	Identifier,
	Keyhive,
	KeyhiveBlobInterceptor,
	KeyhiveStorage,
	KeyhiveSubductionAdapter,
	KEYHIVE_SYNC_SERVER_CONTACT_CARD_JSON,
	SUBDUCTION_SYNC_SERVER_CONTACT_CARD_JSON,
	Signer,
	initKeyhiveWasm,
	peerIdFromSigner,
	setKeyhiveLogLevel,
} from "automerge-repo-keyhive-0.5";
import { PromiseQueue } from "automerge-repo-keyhive-0.5/dist/network-adapter/pending.js";
import type { Docs } from "../docs.js";
import type { DocumentId } from "../url.js";
import {
	type Grantee,
	type Hive,
	type Servers,
	type Settings,
	lock,
	noStorage,
	resolveWith,
	serverTable,
} from "./common.js";

// the built-in servers, with the cards automerge-repo-keyhive 0.5 ships
export const SERVERS: Servers = serverTable({
	keyhive: KEYHIVE_SYNC_SERVER_CONTACT_CARD_JSON,
	subduction: SUBDUCTION_SYNC_SERVER_CONTACT_CARD_JSON,
});

export const resolveSettings = (settings: Settings) => resolveWith(SERVERS, settings);

/** The peer id a contact card's server answers to (its key, base64), or throws if it isn't a card. */
export function cardPeerId(json: string): string {
	initKeyhiveWasm();
	return Buffer.from(ContactCard.fromJson(json).id.toBytes()).toString("base64");
}

// ARK brands ids with automerge-repo's DocumentId; the bs58check string is the same
type ArkDocumentId = Parameters<KeyhiveBlobInterceptor["transformIncoming"]>[0];
const ark = (id: DocumentId) => id as string as ArkDocumentId;

// `file` holds the keyhive archive; the seed signs for both keyhive and subduction.
// A reader neither locks nor writes the archive back.
export async function openHive(
	file: string,
	seed: Uint8Array,
	settings: Settings,
	reader = false,
): Promise<Hive> {
	const { url, card: cardJson } = resolveSettings(settings);
	initKeyhiveWasm();
	if (!/keyhive/.test(process.env.DEBUG ?? "")) setKeyhiveLogLevel("silent");
	const unlock = reader ? undefined : await lock(file);
	const signer = Signer.memorySignerFromBytes(seed);
	const store = CiphertextStore.newInMemory();
	const bytes = await fs.readFile(file).catch(e => {
		if (e.code === "ENOENT") return null;
		throw e;
	});
	const kh = bytes
		? await new Archive(bytes).tryToKeyhive(store, signer, () => {})
		: await Keyhive.init(signer, store, () => {});
	const card = ContactCard.fromJson(cardJson);
	const server = (await kh.getAgent(card.id)) ?? (await kh.receiveContactCard(card)).toAgent();
	// keyhive's wasm is not reentrant: every call into it, ours and ARK's, goes through one queue
	const queue = new PromiseQueue();
	const crypt = new KeyhiveBlobInterceptor(kh, queue);
	let syncer: Promise<() => Promise<void>> | undefined;

	return {
		server: url,
		id: Buffer.from(signer.verifyingKey).toString("base64"),
		contactCard: () => queue.run(async () => (await kh.contactCard()).toJson()),
		codec: {
			async encode(id, head, parents, blob) {
				const out = await crypt.transformOutgoing(ark(id), head, parents, blob);
				if (!out) throw new Error(`cannot encrypt ${id}: keyhive does not know it`);
				return out;
			},
			decode: (id, head, blob) => crypt.transformIncoming(ark(id), head, blob),
		},

		createGroup: access =>
			queue.run(async () => {
				const group = await kh.generateGroup([]);
				if (access.public) {
					const anyone = (await kh.getAgent(Identifier.publicId()))!;
					await kh.addMember(anyone, group.toMembered(), Access.fromString(access.public), []);
				}
				await kh.addMember(server, group.toMembered(), Access.fromString(access.server), []);
				return Buffer.from(group.groupId.toBytes()).toString("hex");
			}),

		groupOf: id =>
			queue.run(async () => {
				const doc = await kh.getDocument(new KeyhiveDocumentId(bs58check.decode(id)));
				const group = (await doc?.members())?.find(m => m.who.isGroup());
				return group && Buffer.from(group.who.id.toBytes()).toString("hex");
			}),

		newId: hex => () =>
			queue.run(async () => {
				const group = (await kh.getGroup(new GroupId(Buffer.from(hex, "hex"))))!;
				const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
				const doc = await kh.generateDocument([group.toPeer()], ref, []);
				return bs58check.encode(doc.doc_id.toBytes()) as DocumentId;
			}),

		canWrite: id =>
			queue.run(async () => {
				const doc = new KeyhiveDocumentId(bs58check.decode(id));
				const edit = Access.edit();
				for (const who of [new Identifier(signer.verifyingKey), Identifier.publicId()]) {
					if ((await kh.bestAccessForDoc(who, doc))?.atLeast(edit)) return true;
				}
				return false;
			}),

		setAccess: (group, who, level) =>
			queue.run(async () => {
				const g = await kh.getGroup(new GroupId(Buffer.from(group, "hex")));
				if (!g) throw new Error(`keyhive doesn't know group ${group}`);
				const agent = await agentFor(kh, who);
				const want = b64(agent.id.toBytes());
				const member = (await g.members()).find(m => b64(m.who.id.toBytes()) === want);
				const current = member?.can.toString().toLowerCase();
				if (current && current !== level) await kh.revokeMember(agent, true, g.toMembered());
				if (level !== "none" && current !== level) {
					// the group's documents, so the new member gets their keys, not just the delegation
					await kh.addMember(agent, g.toMembered(), Access.fromString(level), await groupDocs(kh, group));
				}
			}),

		members: group =>
			queue.run(async () => {
				const g = await kh.getGroup(new GroupId(Buffer.from(group, "hex")));
				if (!g) throw new Error(`keyhive doesn't know group ${group}`);
				const anyone = b64(Identifier.publicId().toBytes());
				return (await g.members()).map(m => {
					const id = b64(m.who.id.toBytes());
					return { id, public: id === anyone, access: m.can.toString().toLowerCase() };
				});
			}),

		groupDocs: group =>
			queue.run(async () => (await groupDocs(kh, group)).map(d => bs58check.encode(d.doc_id.toBytes()) as DocumentId)),

		async sync(docs) {
			const peer = Buffer.from(card.id.toBytes()).toString("base64");
			const connected = (await docs.node.getConnectedPeerIds()).map(p => Buffer.from(p.toBytes()).toString("base64"));
			if (!connected.includes(peer)) {
				throw new Error(`${url} is not the server in the keyhive contact card (it is ${connected[0] ?? "not connected"})`);
			}
			syncer ??= adapterSync(kh, signer, queue, docs.node, peer);
			await (await syncer)();
		},

		// a writer writes back its whole archive, so it holds the lock from open to close
		async close() {
			if (!unlock) return;
			const tmp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(tmp, (await queue.run(() => kh.toArchive())).toBytes(), { mode: 0o600 });
			await fs.rename(tmp, file);
			await unlock();
		},
	};
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

// the documents `group` (hex) is a direct member of
async function groupDocs(kh: Keyhive, group: string) {
	const out = [];
	for (const { doc } of await kh.reachableDocs()) {
		if ((await doc.members()).some(m => Buffer.from(m.who.id.toBytes()).toString("hex") === group)) out.push(doc);
	}
	return out;
}

// the agent a grant is for, receiving the contact card first if keyhive hasn't seen it
async function agentFor(kh: Keyhive, who: Grantee) {
	if ("public" in who) return (await kh.getAgent(Identifier.publicId()))!;
	const card = ContactCard.fromJson(who.card);
	return (await kh.getAgent(card.id)) ?? (await kh.receiveContactCard(card)).toAgent();
}

type Peer = { syncpoint: number | null; lastKeyhiveRequestSent: number };

// ARK has no "synced" signal. A round is done when the server confirms, which sets the
// peer's private syncpoint; rounds repeat while they bring in ops, as the server pages.
async function adapterSync(
	kh: Keyhive,
	signer: Signer,
	queue: PromiseQueue,
	node: Docs["node"],
	serverPeer: string,
) {
	const adapter = new KeyhiveSubductionAdapter({
		subduction: node,
		keyhive: kh,
		keyhiveStorage: new KeyhiveStorage(new Uint8Array(32), noStorage),
		keyhiveQueue: queue,
		contactCard: await queue.run(() => kh.contactCard()),
		localPeerId: peerIdFromSigner(signer),
		remotePeerId: serverPeer as ReturnType<typeof peerIdFromSigner>,
		cachingMode: "none",
	});
	const peer: Peer = (adapter as any).peers.get(serverPeer);
	let confirmed = () => {};
	let syncpoint = peer.syncpoint;
	Object.defineProperty(peer, "syncpoint", {
		get: () => syncpoint,
		set: v => {
			syncpoint = v;
			if (v !== null) confirmed();
		},
	});
	let ingested = false;
	adapter.on("ingest-remote", () => (ingested = true));

	return async () => {
		for (;;) {
			const started = Date.now();
			ingested = false;
			adapter.invalidateCaches();
			// ARK drops a request within 1s of its last one, and counts construction as one
			peer.lastKeyhiveRequestSent = 0;
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("keyhive sync timed out")), 30_000);
				confirmed = () => {
					clearTimeout(timer);
					resolve();
				};
				adapter.syncKeyhive(true);
			});
			if (!ingested) return;
			// the server ignores a request within 1s of the previous one
			await new Promise(r => setTimeout(r, Math.max(0, started + 1000 - Date.now())));
		}
	};
}
