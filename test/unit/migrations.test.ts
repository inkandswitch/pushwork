/**
 * Tests for config migrations: walking an old `.pushwork/config.json` forward
 * to the current version, including the original-pushwork ("main") layout.
 * Fully offline — no repo or network is opened.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";

import {
	migrate,
	detectVersion,
	versionLabel,
	readRawConfig,
	UNVERSIONED,
	type RawConfig,
} from "../../src/migrations.js";
import { readConfig, CONFIG_VERSION } from "../../src/config.js";

tmp.setGracefulCleanup();

let root: string;
let cleanup: () => void;

beforeEach(() => {
	const d = tmp.dirSync({ unsafeCleanup: true });
	root = d.name;
	cleanup = d.removeCallback;
});

afterEach(() => {
	cleanup();
});

const pushwork = (...p: string[]) => path.join(root, ".pushwork", ...p);

async function writeConfigRaw(raw: RawConfig): Promise<void> {
	await fs.mkdir(pushwork(), { recursive: true });
	await fs.writeFile(pushwork("config.json"), JSON.stringify(raw, null, 2));
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

// A real, well-formed automerge URL: automerge-repo@subduction.37 tightened
// parseAutomergeUrl to reject document ids that aren't valid base58check, so
// this fixture must round-trip through the strict parser (readConfig/stripHeads).
const SOME_URL = "automerge:XoQnpXDDPXEtRVPhdQruLDVRduB";

// An original-pushwork ("main") DirectoryConfig.
const mainConfig = (over: RawConfig = {}): RawConfig => ({
	sync_server: "wss://sync3.automerge.org",
	sync_enabled: true,
	root_directory_url: SOME_URL,
	exclude_patterns: [],
	artifact_directories: [],
	sync: { move_detection_threshold: 0.8 },
	...over,
});

describe("detectVersion", () => {
	it("reads an explicit version field", () => {
		expect(detectVersion({ version: 4 })).toBe(4);
		expect(detectVersion({ version: 2 })).toBe(2);
	});

	it("recognizes the pushwork@2 v1 shape by rootUrl", () => {
		expect(detectVersion({ rootUrl: SOME_URL, backend: "legacy" })).toBe(1);
	});

	it("recognizes the original-pushwork layout as '-'", () => {
		expect(detectVersion(mainConfig())).toBe(UNVERSIONED);
		expect(detectVersion({ sync_enabled: true })).toBe(UNVERSIONED);
		expect(detectVersion({ subduction: true })).toBe(UNVERSIONED);
	});

	it("returns null for an unrecognized object", () => {
		expect(detectVersion({ hello: "world" })).toBeNull();
	});
});

describe("versionLabel", () => {
	it("prints '-' for the unversioned format", () => {
		expect(versionLabel(UNVERSIONED)).toBe("-");
		expect(versionLabel(1)).toBe("1");
		expect(versionLabel(4)).toBe("4");
	});
});

describe("migrate '-' (original pushwork) → current", () => {
	it("rewrites config, relocates storage, and drops snapshot.json", async () => {
		await writeConfigRaw(mainConfig());
		// original layout: CRDT data in automerge/, plus a snapshot.json. Use a
		// real nodefs chunk layout (two-char fan-out dir + remainder + name) so
		// the 4 → 5 step can carry the chunk into LMDB.
		await fs.mkdir(pushwork("automerge", "do", "c1"), { recursive: true });
		await fs.writeFile(pushwork("automerge", "do", "c1", "snapshot"), "crdt-bytes");
		await fs.writeFile(
			pushwork("snapshot.json"),
			JSON.stringify({ rootDirectoryUrl: SOME_URL }),
		);

		const result = await migrate(root);

		expect(result.from).toBe(UNVERSIONED);
		expect(result.to).toBe(CONFIG_VERSION);
		expect(result.steps).toEqual(["- → 1", "1 → 2", "2 → 3", "3 → 4", "4 → 5"]);

		// storage moved automerge/ → storage/ ("-" → 1), then storage/ → LMDB
		// with a .bak of the tree (4 → 5); contents preserved in both places
		expect(await exists(pushwork("automerge"))).toBe(false);
		expect(await exists(pushwork("storage"))).toBe(false);
		expect(
			await fs.readFile(pushwork("storage.nodefs.bak", "do", "c1", "snapshot"), "utf8"),
		).toBe("crdt-bytes");
		const { LMDBStorageAdapter } = await import(
			"@automerge/automerge-repo-storage-lmdb"
		);
		const lmdb = new LMDBStorageAdapter(pushwork("storage.lmdb"));
		try {
			expect(await lmdb.load(["doc1", "snapshot"])).toEqual(
				new TextEncoder().encode("crdt-bytes"),
			);
		} finally {
			await lmdb.close();
		}
		// stale snapshot removed
		expect(await exists(pushwork("snapshot.json"))).toBe(false);

		// final config is a valid v4 config; original-pushwork repos are
		// folder-of-docs, so the shape must be patchwork-folder (not vfs)
		const cfg = await readConfig(root);
		expect(cfg).toEqual({
			version: CONFIG_VERSION,
			rootUrl: SOME_URL,
			backend: "legacy",
			shape: "patchwork-folder",
			artifactDirectories: [],
		});
	});

	it("maps subduction:true to the subduction backend", async () => {
		await writeConfigRaw(mainConfig({ subduction: true }));
		await migrate(root);
		const cfg = await readConfig(root);
		expect(cfg.backend).toBe("subduction");
	});

	it("falls back to snapshot.json for the root URL", async () => {
		await writeConfigRaw(mainConfig({ root_directory_url: undefined }));
		await fs.writeFile(
			pushwork("snapshot.json"),
			JSON.stringify({ rootDirectoryUrl: SOME_URL }),
		);
		await migrate(root);
		const cfg = await readConfig(root);
		expect(cfg.rootUrl).toBe(SOME_URL);
	});

	it("uses the patchwork-folder shape (original repos are folder docs)", async () => {
		await writeConfigRaw(mainConfig());
		await migrate(root);
		const cfg = await readConfig(root);
		expect(cfg.shape).toBe("patchwork-folder");
	});

	it("throws when no root URL can be found anywhere", async () => {
		await writeConfigRaw(mainConfig({ root_directory_url: undefined }));
		await expect(migrate(root)).rejects.toThrow(/no root document URL/);
	});
});

describe("migrate from intermediate versions", () => {
	it("1 → current", async () => {
		await writeConfigRaw({ rootUrl: SOME_URL, backend: "subduction" });
		const result = await migrate(root);
		expect(result.from).toBe(1);
		expect(result.steps).toEqual(["1 → 2", "2 → 3", "3 → 4", "4 → 5"]);
		const cfg = await readConfig(root);
		expect(cfg).toEqual({
			version: CONFIG_VERSION,
			rootUrl: SOME_URL,
			backend: "subduction",
			shape: "vfs",
			artifactDirectories: [],
		});
	});

	it("2 → current preserves shape and artifactDirectories", async () => {
		await writeConfigRaw({
			version: 2,
			rootUrl: SOME_URL,
			backend: "legacy",
			shape: "patchwork-folder",
			artifactDirectories: ["assets"],
		});
		const result = await migrate(root);
		expect(result.from).toBe(2);
		expect(result.steps).toEqual(["2 → 3", "3 → 4", "4 → 5"]);
		const cfg = await readConfig(root);
		expect(cfg.shape).toBe("patchwork-folder");
		expect(cfg.artifactDirectories).toEqual(["assets"]);
	});

	it("3 → current drops the branches field", async () => {
		await writeConfigRaw({
			version: 3,
			rootUrl: SOME_URL,
			backend: "legacy",
			shape: "vfs",
			artifactDirectories: [],
			branches: true,
		});
		const result = await migrate(root);
		expect(result.from).toBe(3);
		expect(result.steps).toEqual(["3 → 4", "4 → 5"]);
		const raw = await readRawConfig(root);
		expect(raw).not.toHaveProperty("branches");
		expect(raw.version).toBe(CONFIG_VERSION);
	});

	it("4 → 5 copies nodefs chunks into LMDB and keeps a .bak of the tree", async () => {
		const { NodeFSStorageAdapter } = await import(
			"@automerge/automerge-repo-storage-nodefs"
		);
		const { LMDBStorageAdapter } = await import(
			"@automerge/automerge-repo-storage-lmdb"
		);
		// Seed a nodefs chunk tree the way a v4 repo would have one.
		const nodefs = new NodeFSStorageAdapter(pushwork("storage"));
		await nodefs.save(["doc1", "snapshot", "aaaa"], new Uint8Array([1, 2, 3]));
		await nodefs.save(["doc1", "incremental", "bbbb"], new Uint8Array([4, 5]));
		await nodefs.save(["storage-adapter-id"], new Uint8Array([9]));
		await writeConfigRaw({
			version: 4,
			rootUrl: SOME_URL,
			backend: "legacy",
			shape: "vfs",
			artifactDirectories: [],
		});

		const result = await migrate(root);
		expect(result.steps).toEqual(["4 → 5"]);

		// Data landed in the LMDB database…
		const lmdb = new LMDBStorageAdapter(pushwork("storage.lmdb"));
		try {
			expect(await lmdb.load(["doc1", "snapshot", "aaaa"])).toEqual(
				new Uint8Array([1, 2, 3]),
			);
			expect((await lmdb.loadRange(["doc1"])).length).toBe(2);
			expect(await lmdb.load(["storage-adapter-id"])).toEqual(
				new Uint8Array([9]),
			);
		} finally {
			await lmdb.close();
		}

		// …and the old tree was renamed, not deleted.
		expect(await exists(pushwork("storage"))).toBe(false);
		expect(await exists(pushwork("storage.nodefs.bak"))).toBe(true);
	});

	it("4 → 5 without a nodefs tree just stamps the version", async () => {
		await writeConfigRaw({
			version: 4,
			rootUrl: SOME_URL,
			backend: "legacy",
			shape: "vfs",
			artifactDirectories: [],
		});
		const result = await migrate(root);
		expect(result.steps).toEqual(["4 → 5"]);
		expect(await exists(pushwork("storage.lmdb"))).toBe(false);
		expect((await readRawConfig(root)).version).toBe(CONFIG_VERSION);
	});
});

describe("migrate edge cases", () => {
	it("is a no-op when already current", async () => {
		const current: RawConfig = {
			version: CONFIG_VERSION,
			rootUrl: SOME_URL,
			backend: "legacy",
			shape: "vfs",
			artifactDirectories: [],
		};
		await writeConfigRaw(current);
		const result = await migrate(root);
		expect(result.from).toBe(CONFIG_VERSION);
		expect(result.steps).toEqual([]);
		expect(await readRawConfig(root)).toEqual(current);
	});

	it("throws on an unrecognized config", async () => {
		await writeConfigRaw({ hello: "world" });
		await expect(migrate(root)).rejects.toThrow(/unrecognized/);
	});

	it("throws when the config is newer than this pushwork", async () => {
		await writeConfigRaw({ version: CONFIG_VERSION + 1, rootUrl: SOME_URL });
		await expect(migrate(root)).rejects.toThrow(/newer than this pushwork/);
	});

	it("throws when there's no config at all", async () => {
		await expect(migrate(root)).rejects.toThrow(/no .pushwork\/config\.json/);
	});
});

describe("readConfig integration", () => {
	it("rejects an old config and points at `pushwork migrate`", async () => {
		await writeConfigRaw(mainConfig());
		await expect(readConfig(root)).rejects.toThrow(/pushwork migrate/);
	});

	it("accepts the config after migrating", async () => {
		await writeConfigRaw(mainConfig());
		await migrate(root);
		await expect(readConfig(root)).resolves.toMatchObject({
			version: CONFIG_VERSION,
		});
	});
});
