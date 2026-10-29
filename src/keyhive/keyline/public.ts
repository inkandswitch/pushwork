// Public keyline repos: what "anyone with the URL" means without keyhive's old world user.
//
// Two principals, each with one secret shipped in the clear:
//
//   reader   its archive (prekey secrets, no signing key; that was thrown away). Anyone can
//            decrypt as it; nobody can sign as it, so nobody can rotate it out of a doc.
//   fetcher  its signing seed. Anyone can connect to the server as it and pull bytes.
//
//   owner ─[read]──► reader
//         └[relay]─► fetcher
//
// An outsider syncs subduction and keyhive as the fetcher, then hands what it got to a
// keyhive that *is* the reader, opened from its archive with a signer that can't sign for
// it, and decrypts with that.
//
// "Public" is public to one app: each app has its own pair, and a repo is readable by the
// apps whose pairs it was made public to. Pushwork ships some (public-principals.json, by
// app name) and `pushwork keyhive apps` adds more. A pair is fixed once used: repos made
// public with it stay readable only with it.

import type { webcrypto } from "crypto";
import { Archive, CiphertextStore, ContactCard, Keyhive, Signer } from "@keyhive/keyhive";
import type { Member, PublicPair } from "../common.js";
import apps from "./public-principals.json";

export type PublicPrincipals = {
	/** The reader's archive, base64. */
	readerArchive: string;
	/** The reader's contact card, base64. */
	readerCard: string;
	/** The fetcher's signing seed, hex. */
	fetcherSeed: string;
	/** The fetcher's archive, base64, so it keeps one identity's prekeys across runs. */
	fetcherArchive: string;
	/** The fetcher's contact card, base64. */
	fetcherCard: string;
};

/** The apps pushwork ships pairs for; more can be added (`pushwork keyhive apps`). */
export const BUILT_IN_APPS: Readonly<Record<string, PublicPrincipals>> = apps;

/** Whose public pushwork's public repos are by default: Patchwork's, so Patchwork can read them. */
export const DEFAULT_PUBLIC_APP = "patchwork";

/** What a repo grants to make itself public to the app with these principals. */
export const pairOf = (p: PublicPrincipals): PublicPair => ({ readerCard: p.readerCard, fetcherCard: p.fetcherCard });

export const parseCard = (card: string) => ContactCard.fromBytes(fromB64(card));
export const fetcherSeed = (p: PublicPrincipals) => new Uint8Array(Buffer.from(p.fetcherSeed, "hex"));

/** The fetcher, who can sign and so can sync. */
export const openFetcher = (p: PublicPrincipals) =>
	new Archive(fromB64(p.fetcherArchive)).tryToKeyhive(
		CiphertextStore.newInMemory(),
		Signer.memorySignerFromBytes(fetcherSeed(p)),
		() => {},
	);

/**
 * The reader, who can decrypt but not sign. Keyhive takes an identity from its signer's
 * verifying key, so this one is the reader's key paired with a throwaway private key:
 * anything it signs fails to verify.
 */
export async function openReader(p: PublicPrincipals): Promise<Keyhive> {
	const { subtle } = crypto;
	const key = parseCard(p.readerCard).id.toBytes();
	const publicKey = await subtle.importKey("raw", key, { name: "Ed25519" }, true, ["verify"]);
	const { privateKey } = (await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as unknown as webcrypto.CryptoKeyPair;
	const signer = await Signer.webCryptoSigner({ publicKey, privateKey });
	return new Archive(fromB64(p.readerArchive)).tryToKeyhive(CiphertextStore.newInMemory(), signer, () => {});
}

/** Give `into` every event `from` holds for the fetcher: what a public reader can know. */
export async function relay(from: Keyhive, into: Keyhive, p: PublicPrincipals): Promise<void> {
	const events = (await from.eventsForAgent(await from.getPrincipal(parseCard(p.fetcherCard).id))) as Map<unknown, Uint8Array>;
	if (events.size) await into.ingestEventsBytes([...events.values()]);
}

/** The principals in `raw` (an app's pair, as JSON), or throws saying what is wrong with them. */
export async function parsePrincipals(raw: unknown): Promise<PublicPrincipals> {
	const fields = ["readerArchive", "readerCard", "fetcherSeed", "fetcherArchive", "fetcherCard"] as const;
	const obj = (raw ?? {}) as Record<string, unknown>;
	const missing = fields.filter(k => typeof obj[k] !== "string");
	if (missing.length) throw new Error(`not a public pair: missing ${missing.join(", ")}`);
	const p = Object.fromEntries(fields.map(k => [k, obj[k]])) as PublicPrincipals;
	const id = (card: string, who: string) => {
		try {
			return b64(parseCard(card).id.toBytes());
		} catch {
			throw new Error(`not a public pair: the ${who} card is not a keyhive contact card`);
		}
	};
	const [reader, fetcher] = [id(p.readerCard, "reader"), id(p.fetcherCard, "fetcher")];
	if (reader === fetcher) throw new Error("not a public pair: the reader and fetcher are one principal");
	if (b64(Signer.memorySignerFromBytes(fetcherSeed(p)).verifyingKey) !== fetcher) {
		throw new Error("not a public pair: the fetcher seed is not the fetcher card's key");
	}
	const opened = await Promise.all([openReader(p), openFetcher(p)]).catch(() => {
		throw new Error("not a public pair: an archive does not open");
	});
	if (b64(opened[0].id.toBytes()) !== reader) throw new Error("not a public pair: the reader archive is not the reader's");
	return p;
}

/**
 * `members` with each app's public pair shown as one public entry: its reader when that can
 * read, and its fetcher when it can only relay.
 */
export function labelPublic(members: Member[], apps: Record<string, PublicPrincipals>): Member[] {
	const ids = Object.entries(apps).map(([app, p]) => ({
		app,
		reader: b64(parseCard(p.readerCard).id.toBytes()),
		fetcher: b64(parseCard(p.fetcherCard).id.toBytes()),
	}));
	const out = members.filter(m => !ids.some(p => m.id === p.reader || m.id === p.fetcher));
	for (const { app, reader, fetcher } of ids) {
		const shown = members.find(m => m.id === reader) ?? members.find(m => m.id === fetcher);
		if (shown) out.push({ ...shown, public: true, app });
	}
	return out;
}

/** A new app's public principals, throwing the reader's signing key away. */
export async function generatePublicPrincipals(): Promise<PublicPrincipals> {
	const init = (signer: Signer) => Keyhive.init(signer, CiphertextStore.newInMemory(), () => {});
	const reader = await init(Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32))));
	const seed = crypto.getRandomValues(new Uint8Array(32));
	const fetcher = await init(Signer.memorySignerFromBytes(seed));
	// a card carries a fresh prekey, so each archive is taken after its card
	const readerCard = b64((await reader.contactCard()).toBytes());
	const fetcherCard = b64((await fetcher.contactCard()).toBytes());
	return {
		readerArchive: b64((await reader.toArchive()).toBytes()),
		readerCard,
		fetcherSeed: Buffer.from(seed).toString("hex"),
		fetcherArchive: b64((await fetcher.toArchive()).toBytes()),
		fetcherCard,
	};
}

const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
