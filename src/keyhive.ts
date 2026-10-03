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
} from "@automerge/automerge-repo-keyhive";
import { PromiseQueue } from "@automerge/automerge-repo-keyhive/dist/network-adapter/pending.js";
import type { Codec, Docs } from "./docs.js";
import type { DocumentId } from "./url.js";

// the sync servers ARK knows, by short name
export const SERVERS: Record<string, { url: string; card: string }> = {
	subduction: { url: "wss://subduction.sync.inkandswitch.com", card: SUBDUCTION_SYNC_SERVER_CONTACT_CARD_JSON },
	keyhive: { url: "wss://keyhive.sync.automerge.org", card: KEYHIVE_SYNC_SERVER_CONTACT_CARD_JSON },
};

/** What `pushwork keyhive server` stores: a built-in name, or a url and card (a name or JSON). */
export type Settings = { server?: string; card?: string };

export const DEFAULT_SERVER_NAME = "keyhive";

/** The server url and contact card JSON that keyhive repos sync through. */
export function resolveSettings(settings: Settings): { url: string; card: string } {
	const server = settings.server ?? DEFAULT_SERVER_NAME;
	const named = SERVERS[server];
	const url = named?.url ?? server;
	const card = settings.card ? (SERVERS[settings.card]?.card ?? settings.card) : named?.card;
	if (!card) throw new Error(`no contact card for ${url}; set one with \`pushwork keyhive server ${url} <card>\``);
	return { url, card };
}

/** The peer id a contact card's server answers to (its key, base64), or throws if it isn't a card. */
export function cardPeerId(json: string): string {
	initKeyhiveWasm();
	return Buffer.from(ContactCard.fromJson(json).id.toBytes()).toString("base64");
}

export type AccessLevel = "relay" | "read" | "edit" | "admin";

export type Hive = {
	server: string;
	id: string;
	contactCard(): Promise<string>;
	codec: Codec;
	/** A new group for a repo's docs, granting the public and the server the given access. */
	createGroup(access: { public?: AccessLevel; server: AccessLevel }): Promise<string>;
	/** The group a doc was created in (hex), if this hive knows it. */
	groupOf(id: DocumentId): Promise<string | undefined>;
	newId(group: string): () => Promise<DocumentId>;
	canWrite(id: DocumentId): Promise<boolean>;
	sync(docs: Docs): Promise<void>;
	close(): Promise<void>;
};

// ARK brands ids with automerge-repo's DocumentId; the bs58check string is the same
type ArkDocumentId = Parameters<KeyhiveBlobInterceptor["transformIncoming"]>[0];
const ark = (id: DocumentId) => id as string as ArkDocumentId;

// the archive file is the only persistence, so ARK's own event storage keeps nothing
const noStorage = {
	load: async () => undefined,
	save: async () => {},
	saveBatch: async () => {},
	remove: async () => {},
	loadRange: async () => [],
	removeRange: async () => {},
};

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

const alive = (pid: number) => {
	try {
		return pid > 0 && process.kill(pid, 0);
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

// `file.lock` holds the owner's pid; one left by a run that died is taken over
async function lock(file: string): Promise<() => Promise<void>> {
	const lockFile = `${file}.lock`;
	const tmp = `${lockFile}.${process.pid}`;
	await fs.writeFile(tmp, String(process.pid));
	try {
		for (let stale = false; ; stale = true) {
			const taken = await fs.link(tmp, lockFile).then(
				() => true,
				e => {
					if (e.code === "EEXIST") return false;
					throw e;
				},
			);
			if (taken) return () => fs.rm(lockFile, { force: true });
			const pid = Number(await fs.readFile(lockFile, "utf8").catch(() => 0));
			if (stale || alive(pid)) {
				throw new Error(`${file} is in use by pushwork pid ${pid} (delete ${lockFile} if that process is gone)`);
			}
			await fs.rm(lockFile, { force: true });
		}
	} finally {
		await fs.unlink(tmp);
	}
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
