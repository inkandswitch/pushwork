import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { webcrypto } from "node:crypto";
import {
	Repo,
	WorkerWebSocketEndpoint,
	initSubduction,
	type AutomergeUrl,
	type DocHandle,
} from "@automerge/automerge-repo";
import { LMDBStorageAdapter } from "@automerge/automerge-repo-storage-lmdb";
import {
	Access,
	ContactCard,
	Identifier,
	docIdFromAutomergeUrl,
	initKeyhiveWasm,
	initializeAutomergeRepoKeyhive,
	isUnprotectedDoc,
	setKeyhiveLogLevel,
	NUDGE_FIELD,
	uint8ArrayToHex,
	type AutomergeRepoKeyhive,
	type DocMember,
} from "@automerge/automerge-repo-keyhive";
import { log } from "./log.js";
import { waitForServerSync } from "./repo.js";

const dlog = log("keyhive");

export type Hive = AutomergeRepoKeyhive;

export { isUnprotectedDoc };

export const isProtectedUrl = (url: string): boolean => {
	try {
		return !isUnprotectedDoc(url as AutomergeUrl);
	} catch {
		return false;
	}
};

const SERVERS = {
	subduction: "wss://subduction.sync.inkandswitch.com",
	keyhive: "wss://keyhive.sync.automerge.org",
} as const;

export type KeyhiveServer = keyof typeof SERVERS;

export const keyhiveServer = (): KeyhiveServer =>
	process.env.PUSHWORK_KEYHIVE_SERVER === "keyhive" ? "keyhive" : "subduction";

export const keyhiveUrl = (): string => SERVERS[keyhiveServer()];

export const pushworkHome = (): string =>
	process.env.PUSHWORK_HOME || path.join(os.homedir(), ".pushwork");

export const identityPath = (): string => path.join(pushworkHome(), "keyhive.lmdb");

export async function hasIdentity(): Promise<boolean> {
	try {
		await fs.access(identityPath());
		return true;
	} catch {
		return false;
	}
}

export const NO_IDENTITY =
	"no keyhive identity in use — run `pushwork keyhive` for setup instructions";

/**
 * What `pushwork keyhive use` accepts: the JSON the browser snippet in
 * {@link INSTRUCTIONS} copies. `key` is the Ed25519 private JWK of the
 * Patchwork identity; `prekeys` is the base64 of `exportPrekeySecrets()`,
 * which lets this machine decrypt documents that identity was granted.
 */
export type IdentityBlob = {
	key: webcrypto.JsonWebKey;
	prekeys?: string;
};

export const INSTRUCTIONS = `
Use the keyhive identity of a Patchwork site from the command line.

1. Open the Patchwork site in Chrome, open DevTools → Console, and run:

     copy(JSON.stringify({
       key: await crypto.subtle.exportKey("jwk", hive.active.keyPair.privateKey),
       prekeys: btoa(Array.from(await hive.keyhive.exportPrekeySecrets(), b => String.fromCharCode(b)).join("")),
     }))

   That copies your identity to the clipboard: the private signing key plus
   the prekey secrets needed to decrypt documents shared with you. Treat it
   like a password.

2. Run \`pushwork keyhive use\` and paste it. Or pass it as an argument, or a
   path to a file containing it.

3. \`pushwork init\` now creates keyhive-protected repos. Everyone can read them
   by default; pass --no-world-read to keep a repo private, or --no-keyhive
   for a plain repo. \`pushwork clone <url>\` of a protected repo uses this
   identity, and tells you if you lack access.

Sharing a repo:

   pushwork keyhive status              your identity and contact card
   pushwork keyhive list                who has access to this repo
   pushwork keyhive grant edit '<card>' give someone edit access (read, pull, edit, admin)
   pushwork keyhive grant read world    make the repo world-readable (public and world mean the same)

   A collaborator gets their contact card from \`pushwork keyhive status\`,
   or in a browser with copy(hive.active.contactCard.toJson()).

Identity storage: ${identityPath()} (set PUSHWORK_HOME to move it).
Sync server: ${keyhiveUrl()} (PUSHWORK_KEYHIVE_SERVER=keyhive for wss://keyhive.sync.automerge.org).
`.trimStart();

export function parseIdentity(text: string): IdentityBlob {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.trim());
	} catch {
		throw new Error("identity is not JSON — run `pushwork keyhive` for the snippet that produces it");
	}
	const blob = parsed as Partial<IdentityBlob>;
	const key = blob.key as webcrypto.JsonWebKey | undefined;
	if (!key || key.kty !== "OKP" || key.crv !== "Ed25519" || !key.d || !key.x) {
		throw new Error("identity has no Ed25519 private key under `key`");
	}
	if (blob.prekeys !== undefined && typeof blob.prekeys !== "string") {
		throw new Error("identity `prekeys` must be a base64 string");
	}
	return { key, prekeys: blob.prekeys };
}

async function keyPairFromJwk(jwk: webcrypto.JsonWebKey): Promise<webcrypto.CryptoKeyPair> {
	const { d: _d, ...publicJwk } = jwk;
	const privateKey = await webcrypto.subtle.importKey(
		"jwk",
		{ ...jwk, key_ops: ["sign"] },
		"Ed25519",
		true,
		["sign"],
	);
	const publicKey = await webcrypto.subtle.importKey(
		"jwk",
		{ ...publicJwk, key_ops: ["verify"] },
		"Ed25519",
		true,
		["verify"],
	);
	return { privateKey, publicKey };
}

export type Identity = {
	id: string;
	peerId: string;
	contactCard: string;
	path: string;
};

export function describeIdentity(hive: Hive): Identity {
	return {
		id: uint8ArrayToHex(hive.active.individual.id.toBytes()),
		peerId: hive.peerId,
		contactCard: hive.active.contactCard.toJson(),
		path: identityPath(),
	};
}

/**
 * Replace the identity on this machine with `blob`. Any previous identity's
 * keyhive state is discarded: it was built for a different signer and can't
 * be loaded under the new one.
 */
export async function useIdentity(blob: IdentityBlob): Promise<Identity> {
	await fs.mkdir(pushworkHome(), { recursive: true });
	await fs.rm(identityPath(), { recursive: true, force: true });
	const keyPair = await keyPairFromJwk(blob.key);
	const { repo, hive } = await openHive(undefined, { offline: true, keyPair });
	try {
		if (blob.prekeys) {
			await hive.keyhive.importPrekeySecrets(
				new Uint8Array(Buffer.from(blob.prekeys, "base64")),
			);
			await hive.keyhiveStorage.savePrekeySecrets(hive.keyhive);
		}
		return describeIdentity(hive);
	} finally {
		await repo.shutdown();
		hive.close();
	}
}

/**
 * Open a hive (and the Repo it wraps) for the identity on this machine.
 * `repoStorage` is the repo's LMDB path, or undefined for an in-memory repo.
 * Without `keyPair`, an identity must already exist: pushwork never mints one
 * silently.
 */
export async function openHive(
	repoStorage: string | undefined,
	opts: { offline?: boolean; keyPair?: webcrypto.CryptoKeyPair } = {},
): Promise<{ repo: Repo; hive: Hive }> {
	if (!opts.keyPair && !(await hasIdentity())) throw new Error(NO_IDENTITY);
	await initSubduction();
	initKeyhiveWasm();
	if (/keyhive/.test(process.env.DEBUG ?? "")) setKeyhiveLogLevel("debug");
	const server = keyhiveServer();
	dlog("openHive repo=%s offline=%s server=%s", repoStorage ?? "(memory)", !!opts.offline, server);
	const opened = await initializeAutomergeRepoKeyhive({
		createRepo: (config) => new Repo(config),
		storage: new LMDBStorageAdapter(identityPath()),
		peerIdSuffix: "pushwork",
		keyPair: opts.keyPair,
		syncServer: server,
		periodicallyRequestSync: !opts.offline,
		repo: {
			storage: repoStorage ? new LMDBStorageAdapter(repoStorage) : undefined,
			network: [],
			subductionWebsocketEndpoints: opts.offline
				? []
				: [new WorkerWebSocketEndpoint(keyhiveUrl())],
		},
	});
	disableAutoNudge(opened.hive);
	return opened;
}

/**
 * ARK's linkRepo schedules a membership check after every keyhive event that
 * rotates each doc's key and writes a nudge edit for members it thinks are
 * new. Its memory of who it has seen is per process, so in a CLI that is a
 * fresh process per command it re-rotates every doc on every run, and peers
 * mid-way through catching up lose the key. pushwork nudges explicitly
 * instead, in {@link nudge}, right where membership changes.
 */
function disableAutoNudge(hive: Hive): void {
	hive.networkAdapter.removeAllListeners("ingest-remote");
	for (const fn of hive.emitter.listeners("update")) {
		if (fn.length === 0) hive.emitter.off("update", fn);
	}
}

/**
 * Give members just added to `handle`'s doc a way in: rotate its key so the
 * new member can derive the current one, then write an edit under it.
 */
export async function nudge(hive: Hive, handles: DocHandle<unknown>[]): Promise<void> {
	for (const handle of handles) {
		const doc = await hive.keyhive.getDocument(docIdFromAutomergeUrl(handle.url));
		if (!doc) continue;
		const leafSecret = await hive.keyhive.forcePcsUpdate(doc);
		await hive.keyhiveStorage.saveLeafSecret(leafSecret);
		(handle as DocHandle<Record<string, unknown>>).change((d: Record<string, unknown>) => {
			d[NUDGE_FIELD] = Date.now();
		});
	}
	dlog("nudged %d docs", handles.length);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FLUSH_MS = 1200;

type SyncInternals = {
	peers: Map<string, { syncpoint: number | null }>;
	syncProtocol: { cache: { refresh(keyhive: Hive["keyhive"]): Promise<boolean> } };
	keyhiveQueue: { run<T>(fn: () => Promise<T>): Promise<T> };
};

/**
 * Sync our keyhive with the server both ways: push every local op and pull
 * until nothing new arrives. Needed before trusting any access decision
 * (a grant may be waiting on the server) and before sending document data
 * for a doc whose membership the server hasn't seen. Resolves false on
 * timeout.
 *
 * ARK gathers the ops it offers from a cache that refreshes on a timer, so
 * a request fired right after a local change offers stale ops; each round
 * refreshes the cache first. A round is one full request/response/confirm
 * exchange; a round that ingests nothing new ends the loop. The server pages
 * what it sends, so a big backlog takes many rounds: the limit that matters
 * is a round that never confirms, with `maxMs` as the overall ceiling.
 */
export async function waitForKeyhiveSync(
	hive: Hive,
	{
		maxMs = 180000,
		roundMs = 20000,
		pollMs = 150,
	}: { maxMs?: number; roundMs?: number; pollMs?: number } = {},
): Promise<boolean> {
	const adapter = hive.networkAdapter;
	const { peers, syncProtocol, keyhiveQueue } = adapter as unknown as SyncInternals;
	await sleep(FLUSH_MS);
	let ingestedAt = 0;
	const onIngest = () => {
		ingestedAt = Date.now();
	};
	adapter.on("ingest-remote", onIngest);
	const start = Date.now();
	try {
		for (let round = 1; ; round++) {
			const roundStart = Date.now();
			await keyhiveQueue.run(() => syncProtocol.cache.refresh(hive.keyhive));
			adapter.invalidateCaches();
			adapter.syncKeyhive();
			while (peers.get(adapter.remotePeerId)?.syncpoint == null) {
				if (Date.now() - roundStart >= roundMs || Date.now() - start >= maxMs) {
					dlog("keyhive sync gave up in round %d after %dms", round, Date.now() - start);
					return false;
				}
				await sleep(pollMs);
			}
			if (ingestedAt < roundStart) {
				dlog("keyhive synced in %d rounds, %dms", round, Date.now() - start);
				return true;
			}
			// The protocol drops a request within 1s of the last one.
			await sleep(Math.max(0, 1100 - (Date.now() - roundStart)));
		}
	} finally {
		adapter.off("ingest-remote", onIngest);
	}
}

/** Wait until keyhive knows `url` (its membership has arrived from the server). */
export async function waitForDocMembership(
	hive: Hive,
	url: AutomergeUrl,
	{ maxMs = 30000, pollMs = 200 }: { maxMs?: number; pollMs?: number } = {},
): Promise<boolean> {
	const docId = docIdFromAutomergeUrl(url);
	const start = Date.now();
	for (;;) {
		if (await hive.keyhive.getDocument(docId)) return true;
		if (Date.now() - start >= maxMs) return false;
		await sleep(pollMs);
	}
}

export const ACCESS_LEVELS = ["pull", "read", "edit", "admin"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export function parseAccess(name: string): Access {
	initKeyhiveWasm();
	switch (name.toLowerCase()) {
		case "pull":
		case "relay":
			return Access.relay();
		case "read":
			return Access.read();
		case "edit":
		case "write":
			return Access.edit();
		case "admin":
			return Access.admin();
	}
	throw new Error(`unknown access level "${name}" — use ${ACCESS_LEVELS.join(", ")}`);
}

export function accessName(access: Access): AccessLevel {
	if (access.atLeast(Access.admin())) return "admin";
	if (access.atLeast(Access.edit())) return "edit";
	if (access.atLeast(Access.read())) return "read";
	return "pull";
}

export type Grantee = { kind: "public" } | { kind: "card"; card: ContactCard };

export function parseGrantee(text: string): Grantee {
	const t = text.trim();
	if (["public", "world", "everyone", "anyone"].includes(t.toLowerCase())) {
		return { kind: "public" };
	}
	if (!t.startsWith("{")) {
		throw new Error(
			'grantee must be "public" or a contact card (JSON from `pushwork keyhive status`)',
		);
	}
	initKeyhiveWasm();
	try {
		return { kind: "card", card: ContactCard.fromJson(t) };
	} catch (err) {
		throw new Error(`invalid contact card: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export async function grant(
	hive: Hive,
	url: AutomergeUrl,
	grantee: Grantee,
	access: Access,
): Promise<void> {
	if (grantee.kind === "public") await hive.setPublicAccess(url, access);
	else await hive.addMemberToDoc(url, grantee.card, access);
}

async function grantById(
	hive: Hive,
	url: AutomergeUrl,
	idHex: string,
	access: Access,
): Promise<void> {
	const agent = await hive.keyhive.getAgent(new Identifier(hexToBytes(idHex)));
	if (!agent) throw new Error(`member ${idHex} unknown to keyhive`);
	const doc = await hive.keyhive.getDocument(docIdFromAutomergeUrl(url));
	if (!doc) throw new Error(`document ${url} unknown to keyhive`);
	await hive.keyhive.addMember(agent, doc.toMembered(), access, []);
}

const hexToBytes = (hex: string): Uint8Array =>
	new Uint8Array(Buffer.from(hex, "hex"));

export type Member = {
	id: string;
	access: AccessLevel;
	self: boolean;
	public: boolean;
	server: boolean;
};

const toMember = (m: DocMember): Member => ({
	id: m.id,
	access: accessName(m.access),
	self: m.isSelf,
	public: m.isPublic,
	server: m.isSyncServer,
});

export async function listMembers(hive: Hive, url: AutomergeUrl): Promise<Member[]> {
	return (await hive.listMembers(url)).map(toMember);
}

export async function myAccess(
	hive: Hive,
	url: AutomergeUrl,
): Promise<AccessLevel | undefined> {
	const access = await hive.bestAccessForDoc(hive.active.individual.id, url);
	return access && accessName(access);
}

/**
 * Give `url` the root doc's membership: the sync server as relay, then every
 * other member (public included) at the level the root grants them. Used for
 * docs created since the root was protected — new files, new subfolders.
 */
export async function mirrorMembership(
	hive: Hive,
	rootUrl: AutomergeUrl,
	url: AutomergeUrl,
): Promise<void> {
	await hive.addSyncServerRelayToDoc(url);
	for (const m of await hive.listMembers(rootUrl)) {
		if (m.isSelf || m.isSyncServer) continue;
		if (m.isPublic) await hive.setPublicAccess(url, m.access);
		else await grantById(hive, url, m.id, m.access);
	}
}

/**
 * Every protected doc in `repo.handles` that the sync server can't relay yet
 * gets the root's membership. Returns the handles touched, so the caller can
 * re-send their data once the server has the new membership.
 */
export async function protectNewDocs(
	hive: Hive,
	repo: Repo,
	rootUrl: AutomergeUrl,
): Promise<DocHandle<unknown>[]> {
	const touched: DocHandle<unknown>[] = [];
	for (const handle of Object.values(repo.handles)) {
		if (!isProtectedUrl(handle.url) || handle.url === rootUrl) continue;
		const members = await hive.listMembers(handle.url);
		if (members.some((m) => m.isSyncServer)) continue;
		await mirrorMembership(hive, rootUrl, handle.url);
		touched.push(handle);
	}
	await nudge(hive, touched);
	dlog("protectNewDocs: %d docs given root membership", touched.length);
	return touched;
}

/**
 * The server drops data for a doc whose membership it hasn't received, so
 * after {@link waitForKeyhiveSync} the docs whose membership just changed are
 * re-sent until the server advertises their heads back. Returns the docs it
 * still hasn't confirmed.
 */
export async function resendDocs(
	repo: Repo,
	handles: DocHandle<unknown>[],
	{ attempts = 3, maxMs = 6000 }: { attempts?: number; maxMs?: number } = {},
): Promise<DocHandle<unknown>[]> {
	let pending = handles;
	for (let attempt = 1; pending.length > 0 && attempt <= attempts; attempt++) {
		for (const h of pending) {
			try {
				repo.resyncSubduction(h.documentId);
			} catch (err) {
				dlog("resync %s failed: %s", h.url, err instanceof Error ? err.message : String(err));
			}
		}
		const results = await Promise.all(
			pending.map((h) => waitForServerSync(repo, h, "subduction", { idleMs: 300, maxMs })),
		);
		pending = pending.filter((_, i) => !results[i].synced);
		dlog("resendDocs attempt %d: %d still unconfirmed", attempt, pending.length);
	}
	return pending;
}
