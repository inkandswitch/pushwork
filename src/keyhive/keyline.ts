// Keyhive 0.6 (Keyline) used directly, with no automerge-repo-keyhive: membership and
// encryption from @keyhive/keyhive, and keyhive sync over subduction in ./keyline/sync.ts.
//
// Compared with the ARK versions:
// - contact cards are bytes, so they travel as base64 rather than JSON;
// - there is no public "world" user, so anyone-with-the-URL access is two principals whose
//   secrets pushwork ships (./keyline/public.ts), and goes no further than read;
// - each blob is a keyhive block listing its parents, and decrypting one opens the
//   ancestors it lists, so a doc's blobs are decoded together.

import * as fs from "fs/promises";
import bs58check from "bs58check";
import {
	Archive,
	ChangeId,
	CiphertextStore,
	ContactCard,
	DocumentId as KeyhiveDocumentId,
	Encrypted,
	GroupId,
	Identifier,
	Keyhive,
	MemberedId,
	Power,
	Signer,
} from "@keyhive/keyhive";
import type { Codec, Docs } from "../docs.js";
import type { DocumentId } from "../url.js";
import { type AccessLevel, type Hive, type PublicPair, type Servers, type Settings, lock, resolveWith } from "./common.js";
import * as pub from "./keyline/public.js";
import { type Serial, keylineSync, serial } from "./keyline/sync.js";

// the built-in servers' urls; none ships a Keyline card yet, so each needs one set
export const SERVERS: Servers = {
	subduction: { url: "wss://subduction.sync.inkandswitch.com" },
	keyhive: { url: "wss://keyhive.sync.automerge.org" },
};

// a card set for the ARK versions (JSON, or a built-in name) is no use here
export const resolveSettings = (settings: Settings) =>
	resolveWith(SERVERS, { ...settings, card: settings.card && isCard(settings.card) ? settings.card : undefined });

export { fetchCard } from "./keyline/sync.js";

/** The contact card in a base64 string, or throws if it isn't one. */
export const parseCard = (card: string) => ContactCard.fromBytes(new Uint8Array(Buffer.from(card.trim(), "base64")));

/** The peer id a contact card's holder answers to (its key, base64). */
export const cardPeerId = (card: string) => b64(parseCard(card).id.toBytes());

/** Base64 contact cards are this version's; JSON ones are ARK's. */
export const isCard = (card: string) => /^[A-Za-z0-9+/]{64,}={0,2}$/.test(card.trim());

// `file` holds the keyhive archive; the seed signs for both keyhive and subduction.
// A reader neither locks nor writes the archive back.
export async function openHive(file: string, seed: Uint8Array, settings: Settings, reader = false): Promise<Hive> {
	const { url, card: serverCard } = resolveSettings(settings);
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
	const card = parseCard(serverCard);
	if (!(await kh.hasIndividual(card.individualId))) await kh.receiveContactCard(card);
	const server = card.id;
	const run = serial();
	let syncer: ReturnType<typeof keylineSync> | undefined;

	return {
		server: url,
		id: b64(signer.verifyingKey),
		contactCard: () => run(async () => b64((await kh.contactCard()).toBytes())),
		codec: codec(kh, run),

		createGroup: access =>
			run(async () => {
				const group = await kh.generateGroup([]);
				await kh.addMember(server, MemberedId.group(group), Power.fromString(access.server));
				if (access.public) await setPublic(kh, hex(group.toBytes()), access.public, access.publicPair);
				return hex(group.toBytes());
			}),

		groupOf: id =>
			run(async () => {
				const doc = await kh.getDocument(docId(id));
				for (const { who } of (await doc?.members()) ?? []) {
					if (await kh.hasGroup(new GroupId(who.toBytes()))) return hex(who.toBytes());
				}
				return undefined;
			}),

		newId: group => () =>
			run(async () => {
				const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
				const doc = await kh.generateDocument([groupId(group).toIdentifier()], ref, []);
				return bs58check.encode(doc.toBytes()) as DocumentId;
			}),

		canWrite: id =>
			run(async () => (await kh.accessForDoc(new Identifier(signer.verifyingKey), docId(id)))?.atLeast(Power.edit()) ?? false),

		setAccess: (group, who, level) =>
			run(() =>
				"public" in who ? setPublic(kh, group, level, who.pair) : setMember(kh, group, parseCard(who.card), level),
			),

		members: group =>
			run(async () => {
				const g = await kh.getGroup(groupId(group));
				if (!g) throw new Error(`keyhive doesn't know group ${group}`);
				// apps' public pairs are plain members here; pub.labelPublic shows them as the public
				return (await g.members()).map(m => ({ id: b64(m.who.toBytes()), public: false, access: accessLevel(m.can) }));
			}),

		groupDocs: group =>
			run(async () => {
				const out: DocumentId[] = [];
				for (const { doc } of await kh.reachableDocs()) {
					if ((await doc.members()).some(m => hex(m.who.toBytes()) === group)) {
						out.push(bs58check.encode(doc.docId.toBytes()) as DocumentId);
					}
				}
				return out;
			}),

		async sync(docs: Docs) {
			syncer ??= run(() => kh.contactCard()).then(card =>
				keylineSync({ kh, run, node: docs.node, server: server.toBytes(), card }),
			);
			await (await syncer).sync();
		},

		// a writer writes back its whole archive, so it holds the lock from open to close
		async close() {
			if (!unlock) return;
			const tmp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(tmp, (await run(() => kh.toArchive())).toBytes(), { mode: 0o600 });
			await fs.rename(tmp, file);
			await unlock();
		},
	};
}

function codec(kh: Keyhive, run: Serial): Codec {
	return {
		encode: (id, head, parents, blob) =>
			run(async () => {
				const doc = docId(id);
				if (!(await kh.hasDocument(doc))) throw new Error(`cannot encrypt ${id}: keyhive does not know it`);
				const write = async (preds: string[]) =>
					(await kh.tryEncrypt(doc, changeId(head), preds.map(changeId), blob)).encryptedContent().toBytes();
				// keyhive refuses a parent whose key it has neither written nor read; leaving the
				// parents out means a reader reaches this blob through the doc's key alone
				return write(parents).catch(e => (parents.length ? write([]) : Promise.reject(e)));
			}),

		// Every blob is decrypted with the doc's key where it can be, and the ancestors it
		// lists with the keys it carries: that opens blobs written before this reader had
		// access. Each blob's plaintext comes back once.
		decode: (id, blobs) =>
			run(async () => {
				const doc = docId(id);
				if (!(await kh.hasDocument(doc))) return [];
				// a fragment's head is stored as a loose commit too; an ancestor loads as that
				const byRef = new Map<string, Uint8Array>();
				for (const [head, blob] of blobs) if (!byRef.has(head)) byRef.set(head, blob);
				const seen = new Set<Uint8Array>();
				const out: Uint8Array[] = [];
				for (const [head, blob] of blobs) {
					if (seen.has(blob)) continue;
					const encrypted = parseBlob(blob);
					if (!encrypted || hex(encrypted.contentRef()) !== head) continue;
					const loaded = new Map([[head, blob]]);
					const load = (ref: ChangeId) => {
						const h = hex(ref.toBytes());
						const b = byRef.get(h);
						if (!b || seen.has(b)) return undefined;
						loaded.set(h, b);
						return b;
					};
					const decryption = await kh.tryCausalDecrypt(doc, encrypted, load).catch(() => null);
					for (const block of decryption?.complete() ?? []) {
						const b = loaded.get(hex(block.contentRef.toBytes()));
						if (!b || seen.has(b)) continue;
						seen.add(b);
						out.push(block.content());
					}
				}
				return out;
			}),
	};
}

/**
 * A read-only hive for public repos you aren't a member of: it syncs as the public fetcher
 * (open its docs with `seed`, so subduction connects as the fetcher too) and decrypts as
 * the public reader.
 */
export async function openPublicHive(settings: Settings, app: pub.PublicPrincipals = defaultPublic()) {
	const { url, card: serverCard } = resolveSettings(settings);
	const [fetcher, reader] = await Promise.all([pub.openFetcher(app), pub.openReader(app)]);
	const card = parseCard(serverCard);
	if (!(await fetcher.hasIndividual(card.individualId))) await fetcher.receiveContactCard(card);
	const run = serial();
	let syncer: ReturnType<typeof keylineSync> | undefined;
	return {
		server: url,
		seed: pub.fetcherSeed(app),
		codec: codec(reader, run),
		async sync(docs: Docs) {
			syncer ??= run(() => fetcher.getExistingContactCard()).then(own =>
				keylineSync({ kh: fetcher, run, node: docs.node, server: card.id.toBytes(), card: own }),
			);
			await (await syncer).sync();
			await run(() => pub.relay(fetcher, reader, app));
		},
	};
}

const defaultPublic = () => pub.BUILT_IN_APPS[pub.DEFAULT_PUBLIC_APP];

// The public, as one app's pair (pushwork's default app's unless given): its reader for
// read, its fetcher for relay. Edit would need a principal anyone can sign as to hold a
// key that decrypts, and admin more than that.
async function setPublic(kh: Keyhive, group: string, level: AccessLevel | "none", pair: PublicPair = pub.pairOf(defaultPublic())) {
	if (level === "edit" || level === "admin") {
		throw new Error(`public access in keyline goes up to read, not ${level}; grant ${level} to contacts instead`);
	}
	await setMember(kh, group, parseCard(pair.fetcherCard), level === "none" ? "none" : "relay");
	await setMember(kh, group, parseCard(pair.readerCard), level === "read" ? "read" : "none");
}

// give `card`'s holder `level` on `group`, replacing what it had; receives the card if new
async function setMember(kh: Keyhive, group: string, card: ContactCard, level: AccessLevel | "none") {
	if (!(await kh.hasIndividual(card.individualId))) await kh.receiveContactCard(card);
	const membered = MemberedId.group(groupId(group));
	const current = await accessOf(kh, group, card.id);
	if (current === level || (!current && level === "none")) return;
	if (current) await kh.revokeMember(card.id, true, membered);
	if (level !== "none") await kh.addMember(card.id, membered, Power.fromString(level));
}

// `id`'s current direct access to `group`, if it has any
async function accessOf(kh: Keyhive, group: string, id: Identifier): Promise<AccessLevel | undefined> {
	const want = hex(id.toBytes());
	const member = (await (await kh.getGroup(groupId(group)))?.members())?.find(m => hex(m.who.toBytes()) === want);
	return member && accessLevel(member.can);
}

const accessLevel = (p: Power) => p.toString().toLowerCase() as AccessLevel;

function parseBlob(blob: Uint8Array): Encrypted | null {
	try {
		return Encrypted.fromBytes(blob);
	} catch {
		return null;
	}
}

const docId = (id: DocumentId) => new KeyhiveDocumentId(bs58check.decode(id));
const groupId = (group: string) => new GroupId(new Uint8Array(Buffer.from(group, "hex")));
const changeId = (head: string) => new ChangeId(new Uint8Array(Buffer.from(head, "hex")));

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
