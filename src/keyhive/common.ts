// What both keyhive versions share: settings, the hive interface, the archive lock and
// where each version keeps its archive.

import * as fs from "fs/promises";
import * as path from "path";
import type { Codec, Docs } from "../docs.js";
import type { DocumentId } from "../url.js";

/**
 * The automerge-repo-keyhive a repo uses. 0.5 and 0.6 can't read each other's archives
 * or talk to each other's servers, so each repo records its own and each has its own
 * archive.
 */
export const KEYHIVE_VERSIONS = ["0.5", "0.6"] as const;
export type KeyhiveVersion = (typeof KEYHIVE_VERSIONS)[number];
/** What new keyhive repos use. */
export const DEFAULT_KEYHIVE_VERSION: KeyhiveVersion = "0.6";
/** What a repo without a recorded version was made with: before versions there was only 0.5. */
export const LEGACY_KEYHIVE_VERSION: KeyhiveVersion = "0.5";

export const isKeyhiveVersion = (v: unknown): v is KeyhiveVersion => KEYHIVE_VERSIONS.includes(v as KeyhiveVersion);

/** What `pushwork keyhive server` stores: a built-in name, or a url and card (a name or JSON). */
export type Settings = { server?: string; card?: string };

export const DEFAULT_SERVER_NAME = "subduction";
/** The keyhive server of repos from before configs recorded one. */
export const LEGACY_SERVER_NAME = "keyhive";

export type Servers = Record<string, { url: string; card: string }>;

// the sync servers ARK knows, by short name, with the cards the package ships
export const serverTable = (cards: { keyhive: string; subduction: string }): Servers => ({
	subduction: { url: "wss://subduction.sync.inkandswitch.com", card: cards.subduction },
	keyhive: { url: "wss://keyhive.sync.automerge.org", card: cards.keyhive },
});

/** The server url and contact card JSON that keyhive repos sync through. */
export function resolveWith(servers: Servers, settings: Settings): { url: string; card: string } {
	const server = settings.server ?? DEFAULT_SERVER_NAME;
	const named = servers[server] ?? Object.values(servers).find(s => s.url === server);
	const url = named?.url ?? server;
	const card = settings.card ? (servers[settings.card]?.card ?? settings.card) : named?.card;
	if (!card) throw new Error(`no contact card for ${url}; set one with \`pushwork keyhive server ${url} <card>\``);
	return { url, card };
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

// the archive file is the only persistence, so ARK's own event storage keeps nothing
export const noStorage = {
	load: async () => undefined,
	save: async () => {},
	saveBatch: async () => {},
	remove: async () => {},
	loadRange: async () => [],
	removeRange: async () => {},
};

/**
 * The archive file for `version` under `dir` (`~/.pushwork/keyhive`): `dir/<version>/archive`.
 * Before versions, `dir` was the 0.5 archive itself; that file is moved into place first.
 */
export async function archiveFile(dir: string, version: KeyhiveVersion): Promise<string> {
	const moving = `${dir}.moving`;
	const kind = await fs.stat(dir).then(
		s => (s.isFile() ? "file" : "dir"),
		e => {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return "none";
			throw e;
		},
	);
	if (kind === "file") {
		if (await exists(`${dir}.lock`)) {
			throw new Error(`${dir} is in use by another pushwork; move it once that has finished`);
		}
		await fs.rename(dir, moving);
	}
	// also picks up a move that stopped between the two renames
	if (kind !== "dir" && (await exists(moving))) {
		await fs.mkdir(path.join(dir, "0.5"), { recursive: true });
		await fs.rename(moving, path.join(dir, "0.5", "archive"));
	}
	await fs.mkdir(path.join(dir, version), { recursive: true });
	return path.join(dir, version, "archive");
}

const exists = (file: string) =>
	fs.access(file).then(
		() => true,
		() => false,
	);

const alive = (pid: number) => {
	try {
		return pid > 0 && process.kill(pid, 0);
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

// `file.lock` holds the owner's pid; one left by a run that died is taken over
export async function lock(file: string): Promise<() => Promise<void>> {
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
