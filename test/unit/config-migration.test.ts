import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import {
  ConfigManager,
  resolveProtocol,
  pickAvailableBackupPath,
} from "../../src/core/config";
import {
  CONFIG_VERSION,
  DEFAULT_SUBDUCTION_SERVER,
  DEFAULT_SYNC_SERVER,
} from "../../src/types/config";

describe("resolveProtocol", () => {
  it("returns 'subduction' for null/undefined (new-install default)", () => {
    expect(resolveProtocol(null)).toBe("subduction");
    expect(resolveProtocol(undefined)).toBe("subduction");
  });

  it("trusts explicit v1 protocol field", () => {
    expect(resolveProtocol({ protocol: "subduction" })).toBe("subduction");
    expect(resolveProtocol({ protocol: "legacy" })).toBe("legacy");
  });

  it("maps v0 subduction: true to 'subduction'", () => {
    expect(resolveProtocol({ subduction: true })).toBe("subduction");
  });

  it("maps v0 subduction: false to 'legacy'", () => {
    expect(resolveProtocol({ subduction: false })).toBe("legacy");
  });

  it("treats v0 with absent subduction field as 'legacy' (pre-flip WebSocket user)", () => {
    // v0 config, sync_enabled present but no `subduction` key and no
    // `config_version` — this is the classic pre-PR-21 shape.
    expect(resolveProtocol({ sync_enabled: true })).toBe("legacy");
  });

  it("defaults to 'subduction' for a v1 config missing protocol (defensive)", () => {
    expect(resolveProtocol({ config_version: CONFIG_VERSION })).toBe(
      "subduction"
    );
  });
});

describe("pickAvailableBackupPath", () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(() => {
    cleanup();
  });

  it("returns <base>.bak when no backup exists", async () => {
    const base = path.join(tmpDir, "config.json");
    expect(await pickAvailableBackupPath(base)).toBe(`${base}.bak`);
  });

  it("appends .1 when .bak already exists", async () => {
    const base = path.join(tmpDir, "config.json");
    await fs.writeFile(`${base}.bak`, "first");
    expect(await pickAvailableBackupPath(base)).toBe(`${base}.bak.1`);
  });

  it("keeps counting up through collisions", async () => {
    const base = path.join(tmpDir, "config.json");
    await fs.writeFile(`${base}.bak`, "a");
    await fs.writeFile(`${base}.bak.1`, "b");
    await fs.writeFile(`${base}.bak.2`, "c");
    expect(await pickAvailableBackupPath(base)).toBe(`${base}.bak.3`);
  });
});

describe("ConfigManager.migrateIfNeeded", () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(async () => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
    await fs.mkdir(path.join(tmpDir, ".pushwork"), { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  async function writeConfig(raw: Record<string, unknown>): Promise<void> {
    await fs.writeFile(
      path.join(tmpDir, ".pushwork", "config.json"),
      JSON.stringify(raw, null, 2),
      "utf8"
    );
  }

  async function readConfig(): Promise<Record<string, unknown>> {
    const s = await fs.readFile(
      path.join(tmpDir, ".pushwork", "config.json"),
      "utf8"
    );
    return JSON.parse(s);
  }

  it("no-op when config doesn't exist", async () => {
    const mgr = new ConfigManager(tmpDir);
    const result = await mgr.migrateIfNeeded();
    expect(result.migrated).toBe(false);
  });

  it("no-op when config is already v1", async () => {
    await writeConfig({
      config_version: 1,
      protocol: "subduction",
      sync_enabled: true,
      sync_server: DEFAULT_SUBDUCTION_SERVER,
      exclude_patterns: [],
      artifact_directories: [],
      sync: { move_detection_threshold: 0.7 },
    });
    const mgr = new ConfigManager(tmpDir);
    const result = await mgr.migrateIfNeeded();
    expect(result.migrated).toBe(false);
  });

  it("migrates v0 subduction: true to v1 protocol: 'subduction'", async () => {
    await writeConfig({
      subduction: true,
      sync_enabled: true,
      sync_server: DEFAULT_SUBDUCTION_SERVER,
      exclude_patterns: [],
      artifact_directories: [],
      sync: { move_detection_threshold: 0.7 },
    });

    const mgr = new ConfigManager(tmpDir);
    const result = await mgr.migrateIfNeeded();
    if (!result.migrated) throw new Error("expected migration");

    expect(result.protocol).toBe("subduction");
    expect(result.backupPath).toMatch(/config\.json\.bak$/);

    const migrated = await readConfig();
    expect(migrated.config_version).toBe(1);
    expect(migrated.protocol).toBe("subduction");
    expect(migrated.subduction).toBeUndefined();
  });

  it("migrates v0 with no subduction field to v1 protocol: 'legacy'", async () => {
    await writeConfig({
      sync_enabled: true,
      sync_server: DEFAULT_SYNC_SERVER,
      sync_server_storage_id: "3760df37-a4c6-4f66-9ecd-732039a9385d",
      exclude_patterns: [],
      artifact_directories: [],
      sync: { move_detection_threshold: 0.7 },
    });

    const mgr = new ConfigManager(tmpDir);
    const result = await mgr.migrateIfNeeded();
    if (!result.migrated) throw new Error("expected migration");

    expect(result.protocol).toBe("legacy");

    const migrated = await readConfig();
    expect(migrated.config_version).toBe(1);
    expect(migrated.protocol).toBe("legacy");
    expect(migrated.sync_server_storage_id).toBe(
      "3760df37-a4c6-4f66-9ecd-732039a9385d"
    );
  });

  it("writes a backup of the original v0 config", async () => {
    const v0 = {
      subduction: true,
      sync_enabled: true,
      sync_server: DEFAULT_SUBDUCTION_SERVER,
      exclude_patterns: ["foo"],
      artifact_directories: [],
      sync: { move_detection_threshold: 0.7 },
    };
    await writeConfig(v0);

    const mgr = new ConfigManager(tmpDir);
    const result = await mgr.migrateIfNeeded();
    if (!result.migrated) throw new Error("expected migration");

    const backup = await fs.readFile(result.backupPath, "utf8");
    expect(JSON.parse(backup)).toEqual(v0);
  });

  it("picks .bak.1 when .bak already exists from prior migration", async () => {
    // Simulate: someone manually reverted to v0, left the prior backup
    // in place, then re-ran pushwork.
    await writeConfig({
      subduction: true,
      sync_enabled: true,
      sync_server: DEFAULT_SUBDUCTION_SERVER,
      exclude_patterns: [],
      artifact_directories: [],
      sync: { move_detection_threshold: 0.7 },
    });
    await fs.writeFile(
      path.join(tmpDir, ".pushwork", "config.json.bak"),
      "old backup",
      "utf8"
    );

    const mgr = new ConfigManager(tmpDir);
    const result = await mgr.migrateIfNeeded();
    if (!result.migrated) throw new Error("expected migration");

    expect(result.backupPath).toMatch(/config\.json\.bak\.1$/);

    // Original .bak untouched.
    const original = await fs.readFile(
      path.join(tmpDir, ".pushwork", "config.json.bak"),
      "utf8"
    );
    expect(original).toBe("old backup");
  });

  it("throws on a config_version newer than we understand", async () => {
    await writeConfig({
      config_version: 999,
      protocol: "subduction",
      sync_enabled: true,
      sync_server: DEFAULT_SUBDUCTION_SERVER,
      exclude_patterns: [],
      artifact_directories: [],
      sync: { move_detection_threshold: 0.7 },
    });
    const mgr = new ConfigManager(tmpDir);
    await expect(mgr.migrateIfNeeded()).rejects.toThrow(/newer/);
  });

  it("legacy migration ensures sync_server + storage_id are present", async () => {
    // v0 config that somehow lacks a sync_server (corner case). Should
    // fall back to DEFAULT_SYNC_SERVER during migration.
    await writeConfig({
      subduction: false,
      sync_enabled: true,
      exclude_patterns: [],
      artifact_directories: [],
      sync: { move_detection_threshold: 0.7 },
    });

    const mgr = new ConfigManager(tmpDir);
    const result = await mgr.migrateIfNeeded();
    if (!result.migrated) throw new Error("expected migration");

    const migrated = await readConfig();
    expect(migrated.protocol).toBe("legacy");
    expect(migrated.sync_server).toBe(DEFAULT_SYNC_SERVER);
    expect(migrated.sync_server_storage_id).toBeDefined();
  });

  it("subduction migration strips any stale sync_server_storage_id", async () => {
    // A v0 config where `subduction: true` was set but the storage_id
    // field leaked through from the defaults.
    await writeConfig({
      subduction: true,
      sync_enabled: true,
      sync_server: DEFAULT_SUBDUCTION_SERVER,
      sync_server_storage_id: "stale-id",
      exclude_patterns: [],
      artifact_directories: [],
      sync: { move_detection_threshold: 0.7 },
    });

    const mgr = new ConfigManager(tmpDir);
    const result = await mgr.migrateIfNeeded();
    if (!result.migrated) throw new Error("expected migration");

    const migrated = await readConfig();
    expect(migrated.protocol).toBe("subduction");
    expect(migrated.sync_server_storage_id).toBeUndefined();
  });
});
