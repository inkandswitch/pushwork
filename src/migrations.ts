/**
 * Config migrations.
 *
 * `.pushwork/config.json` has changed shape over the life of the project. This
 * module knows how to take any older config — including the pre-v2 "main"
 * layout (the original pushwork, before this rewrite) — and walk it forward,
 * one version at a time, to {@link CONFIG_VERSION}.
 *
 * Versions, oldest to newest:
 *
 *   "-"  the original pushwork ("main") layout. No `version` field. Config is a
 *        `DirectoryConfig`: { sync_server, sync_enabled, root_directory_url,
 *        subduction, artifact_directories, ... }. CRDT data lives in
 *        `.pushwork/automerge/`, with a `.pushwork/snapshot.json` state file.
 *     1  first pushwork@2 layout. No `version` field. { rootUrl, backend }.
 *        CRDT data lives in `.pushwork/storage/`.
 *     2  adds `version: 2`, `shape`, `artifactDirectories`.
 *     3  adds `branches: boolean`.
 *     4  drops `branches`.
 *     5  moves CRDT storage from the nodefs chunk tree (`.pushwork/storage/`)
 *        into a single LMDB database (`.pushwork/storage.lmdb`) (current).
 *
 * Each migration is a small, pure-ish step stored in {@link migrations}. The
 * "-"→1 step is the only one that touches the filesystem (it relocates the
 * storage directory); the rest only reshape the JSON.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { CONFIG_VERSION, pushworkDir } from "./config.js";

/** The "-" (pre-versioned, original-pushwork) format, represented internally. */
export const UNVERSIONED = 0;

export type ConfigVersion = number;

/** A config object of unknown/any version — we only validate per migration. */
export type RawConfig = Record<string, unknown>;

export interface Migration {
	/** Version this migration upgrades from. */
	from: ConfigVersion;
	/** Version this migration produces. */
	to: ConfigVersion;
	/** Reshape `raw` (and touch disk if needed); return the upgraded config. */
	run(root: string, raw: RawConfig): Promise<RawConfig>;
}

const configFile = (root: string) => path.join(pushworkDir(root), "config.json");

const MIGRATE_HINT = "run `pushwork migrate` to upgrade it";

/** Human label for a version; the original "main" format prints as "-". */
export const versionLabel = (v: ConfigVersion): string =>
	v === UNVERSIONED ? "-" : String(v);

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/** Read `.pushwork/config.json` without validating its version. */
export async function readRawConfig(root: string): Promise<RawConfig> {
	const text = await fs.readFile(configFile(root), "utf8");
	return JSON.parse(text) as RawConfig;
}

async function writeRawConfig(root: string, raw: RawConfig): Promise<void> {
	await fs.mkdir(pushworkDir(root), { recursive: true });
	await fs.writeFile(configFile(root), JSON.stringify(raw, null, 2) + "\n");
}

/**
 * Figure out which config version `raw` is. Returns `null` when it matches no
 * known layout. Note that both "-" and 1 lack a `version` field, so they're
 * told apart by their fields.
 */
export function detectVersion(raw: RawConfig): ConfigVersion | null {
	if (typeof raw.version === "number") return raw.version;
	// pushwork@2 v1: { rootUrl, backend }, no version field.
	if (typeof raw.rootUrl === "string") return 1;
	// original-pushwork ("main") DirectoryConfig: no version, no rootUrl, but
	// carries one of these tell-tale keys.
	if (
		"root_directory_url" in raw ||
		"sync_server" in raw ||
		"sync_enabled" in raw ||
		"subduction" in raw
	) {
		return UNVERSIONED;
	}
	return null;
}

/** Read `rootDirectoryUrl` out of an original-pushwork `snapshot.json`. */
async function readSnapshotRootUrl(root: string): Promise<string | undefined> {
	try {
		const text = await fs.readFile(
			path.join(pushworkDir(root), "snapshot.json"),
			"utf8",
		);
		const snap = JSON.parse(text) as { rootDirectoryUrl?: string };
		return snap.rootDirectoryUrl;
	} catch {
		return undefined;
	}
}

/**
 * "-" → 1: original-pushwork ("main") layout to the first pushwork@2 layout.
 *
 * Pulls the root URL from the config (`root_directory_url`) or, failing that,
 * from `snapshot.json`; maps `subduction` to a backend; relocates the CRDT
 * store from `.pushwork/automerge/` to `.pushwork/storage/`; and drops the now
 * meaningless `snapshot.json` (pushwork@2 rebuilds its own saved state).
 */
async function migrateUnversionedTo1(
	root: string,
	raw: RawConfig,
): Promise<RawConfig> {
	let rootUrl = typeof raw.root_directory_url === "string"
		? raw.root_directory_url
		: undefined;
	if (!rootUrl) rootUrl = await readSnapshotRootUrl(root);
	if (!rootUrl) {
		throw new Error(
			"can't migrate: no root document URL found in .pushwork/config.json " +
				"or .pushwork/snapshot.json",
		);
	}
	const backend = raw.subduction ? "subduction" : "legacy";

	const automerge = path.join(pushworkDir(root), "automerge");
	const storage = path.join(pushworkDir(root), "storage");
	if ((await exists(automerge)) && !(await exists(storage))) {
		await fs.rename(automerge, storage);
	}

	await fs.rm(path.join(pushworkDir(root), "snapshot.json"), { force: true });

	// Original-pushwork repos are always folder-of-docs ("patchwork-folder")
	// structures, never single-doc "vfs" directories. Carry that forward so the
	// 1 → 2 step stamps the right shape; without it the migrated repo would be
	// decoded as vfs and complain it "expected a directory doc".
	return { rootUrl, backend, shape: "patchwork-folder" };
}

/**
 * 1 → 2: stamp `version`, add `artifactDirectories`, and record the `shape`.
 *
 * A `shape` carried in from the "-" → 1 step is honored; a genuine native v1
 * repo has no shape and defaults to "vfs" (the single-doc directory layout v1
 * always produced).
 */
async function migrate1To2(_root: string, raw: RawConfig): Promise<RawConfig> {
	return {
		version: 2,
		rootUrl: raw.rootUrl,
		backend: raw.backend,
		shape: typeof raw.shape === "string" ? raw.shape : "vfs",
		artifactDirectories: [],
	};
}

/** 2 → 3: introduce `branches`, defaulting to the historical value `true`. */
async function migrate2To3(_root: string, raw: RawConfig): Promise<RawConfig> {
	return { ...raw, version: 3, branches: true };
}

/** 3 → 4: drop the short-lived `branches` field. */
async function migrate3To4(_root: string, raw: RawConfig): Promise<RawConfig> {
	const { branches: _branches, ...rest } = raw;
	return { ...rest, version: 4 };
}

/**
 * 4 → 5: move CRDT storage from the nodefs chunk tree (`.pushwork/storage/`,
 * one file per chunk) into a single LMDB database (`.pushwork/storage.lmdb`).
 *
 * All chunks are copied in one LMDB transaction (all-or-nothing), then the
 * old tree is renamed to `.pushwork/storage.nodefs.bak` (collision-safe:
 * `.bak.N` when taken) — kept as a backup rather than deleted, matching the
 * `.bak` precedent of earlier migrations. An empty tree has nothing to back
 * up and is removed; a repo with no tree at all just gets the version stamp.
 *
 * Crash-safe by construction: if a previous run copied into the LMDB file
 * but died before the rename/config write, re-running overwrites the same
 * keys with the same bytes (idempotent) and finishes the rename.
 *
 * Memory: the whole store is materialized once (`loadRange([])` returns an
 * array; the copy into LMDB shares the chunk buffers, so peak ≈ store size).
 * Fine for the repo sizes pushwork targets; a streaming enumeration API in
 * the storage interface would lift this if multi-GB stores ever appear.
 */
async function migrate4To5(root: string, raw: RawConfig): Promise<RawConfig> {
	const storage = path.join(pushworkDir(root), "storage");
	const lmdbPath = `${storage}.lmdb`;

	if (await exists(storage)) {
		const { NodeFSStorageAdapter } = await import(
			"@automerge/automerge-repo-storage-nodefs"
		);
		const { LMDBStorageAdapter } = await import(
			"@automerge/automerge-repo-storage-lmdb"
		);
		// The empty prefix enumerates the whole store (conformance-suite
		// guaranteed as of the storage-lmdb publish train).
		const chunks = await new NodeFSStorageAdapter(storage).loadRange([]);
		const entries = chunks.flatMap((c) =>
			c.data ? [[[...c.key], c.data] as [string[], Uint8Array]] : [],
		);
		if (entries.length > 0) {
			const lmdb = new LMDBStorageAdapter(lmdbPath);
			try {
				await lmdb.saveBatch(entries);
			} finally {
				await lmdb.close();
			}
			await fs.rename(storage, await freeBakPath(`${storage}.nodefs.bak`));
		} else {
			// Nothing to back up: the tree held no chunks (at most staged tmp
			// writes, which the two-phase contract says are discardable).
			await fs.rm(storage, { recursive: true, force: true });
		}
	}

	return { ...raw, version: 5 };
}

/** First of `base`, `base.1`, `base.2`, … that doesn't exist yet. */
async function freeBakPath(base: string): Promise<string> {
	if (!(await exists(base))) return base;
	for (let n = 1; ; n++) {
		const candidate = `${base}.${n}`;
		if (!(await exists(candidate))) return candidate;
	}
}

/** Every migration, in order. Add new steps to the end as the format evolves. */
export const migrations: Migration[] = [
	{ from: UNVERSIONED, to: 1, run: migrateUnversionedTo1 },
	{ from: 1, to: 2, run: migrate1To2 },
	{ from: 2, to: 3, run: migrate2To3 },
	{ from: 3, to: 4, run: migrate3To4 },
	{ from: 4, to: 5, run: migrate4To5 },
];

export interface MigrateResult {
	/** Detected starting version. */
	from: ConfigVersion;
	/** Resulting version (always {@link CONFIG_VERSION}). */
	to: ConfigVersion;
	/** Human-readable step labels, e.g. `["- → 1", "1 → 2"]`. Empty if no-op. */
	steps: string[];
}

/**
 * Migrate `.pushwork/config.json` in `root` up to {@link CONFIG_VERSION},
 * writing the result back to disk. A no-op (empty `steps`) when already current.
 */
export async function migrate(root: string): Promise<MigrateResult> {
	let raw: RawConfig;
	try {
		raw = await readRawConfig(root);
	} catch {
		throw new Error(`no .pushwork/config.json found in ${root}`);
	}

	const from = detectVersion(raw);
	if (from === null) {
		throw new Error(
			`unrecognized .pushwork/config.json — not any known pushwork config version`,
		);
	}
	if (from > CONFIG_VERSION) {
		throw new Error(
			`config version ${from} is newer than this pushwork (${CONFIG_VERSION}); upgrade pushwork`,
		);
	}
	if (from === CONFIG_VERSION) {
		return { from, to: CONFIG_VERSION, steps: [] };
	}

	let cur = raw;
	let v = from;
	const steps: string[] = [];
	while (v < CONFIG_VERSION) {
		const step = migrations.find((m) => m.from === v);
		if (!step) {
			throw new Error(`no migration registered from version ${versionLabel(v)}`);
		}
		cur = await step.run(root, cur);
		steps.push(`${versionLabel(step.from)} → ${versionLabel(step.to)}`);
		v = step.to;
	}

	await writeRawConfig(root, cur);
	return { from, to: CONFIG_VERSION, steps };
}

export { MIGRATE_HINT };
