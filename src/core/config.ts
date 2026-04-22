import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  GlobalConfig,
  DirectoryConfig,
  DEFAULT_SYNC_SERVER,
  DEFAULT_SYNC_SERVER_STORAGE_ID,
  DEFAULT_SUBDUCTION_SERVER,
  CONFIG_VERSION,
  SyncProtocol,
} from "../types";
import { pathExists, ensureDirectoryExists } from "../utils";

/**
 * Determine which sync protocol a (possibly v0) config specifies.
 *
 * Rules:
 *   1. If `config.protocol` is set (v1), trust it.
 *   2. Else if `config.subduction === true` (v0 opt-in Subduction user),
 *      return "subduction".
 *   3. Else (absent or `false`) return "legacy" — pre-flip WebSocket
 *      install or an explicit v0 opt-out.
 *
 * Passing `undefined` returns `"subduction"` (the default for *new*
 * installs).
 */
export function resolveProtocol(
  config: Partial<DirectoryConfig> | null | undefined
): SyncProtocol {
  if (!config) return "subduction";
  if (config.protocol) return config.protocol;
  if (config.subduction === true) return "subduction";
  if (config.subduction === false) return "legacy";
  // v0 config with no subduction field → pre-flip WebSocket user
  if (config.config_version === undefined) return "legacy";
  // v1 config that somehow lacks `protocol` — shouldn't happen for
  // anything we wrote, but default defensively to the modern choice.
  return "subduction";
}

/**
 * Pick an available backup path for a v0 config we're about to migrate.
 *
 * Starts at `<base>.bak`. If that already exists (a previous migration
 * left one behind), append `.1`, `.2`, ... until a free slot is found.
 * This preserves every historical backup instead of silently
 * overwriting.
 */
export async function pickAvailableBackupPath(base: string): Promise<string> {
  const primary = `${base}.bak`;
  if (!(await pathExists(primary))) return primary;
  for (let n = 1; n < 1000; n++) {
    const candidate = `${primary}.${n}`;
    if (!(await pathExists(candidate))) return candidate;
  }
  // Astronomically unlikely. Fall through with a timestamp to avoid
  // infinite loops if someone manually created 1000 backups.
  return `${primary}.${Date.now()}`;
}

/**
 * Configuration manager for pushwork
 */
export class ConfigManager {
  private static readonly GLOBAL_CONFIG_DIR = ".pushwork";
  private static readonly CONFIG_FILENAME = "config.json";

  static readonly CONFIG_DIR = ".pushwork";

  constructor(private workingDir?: string) {}

  /**
   * Get global configuration path
   */
  private getGlobalConfigPath(): string {
    return path.join(
      os.homedir(),
      ConfigManager.GLOBAL_CONFIG_DIR,
      ConfigManager.CONFIG_FILENAME
    );
  }

  /**
   * Get local configuration path
   */
  private getLocalConfigPath(): string {
    if (!this.workingDir) {
      throw new Error("Working directory not set for local config");
    }
    return path.join(
      this.workingDir,
      ConfigManager.CONFIG_DIR,
      ConfigManager.CONFIG_FILENAME
    );
  }

  /**
   * Load global configuration
   */
  async loadGlobal(): Promise<GlobalConfig | null> {
    try {
      const configPath = this.getGlobalConfigPath();
      if (!(await pathExists(configPath))) {
        return null;
      }

      const content = await fs.readFile(configPath, "utf8");
      return JSON.parse(content) as GlobalConfig;
    } catch (error) {
      // Failed to load global config
      return null;
    }
  }

  /**
   * Save global configuration
   */
  async saveGlobal(config: GlobalConfig): Promise<void> {
    try {
      const configPath = this.getGlobalConfigPath();
      await ensureDirectoryExists(path.dirname(configPath));

      const content = JSON.stringify(config, null, 2);
      await fs.writeFile(configPath, content, "utf8");
    } catch (error) {
      throw new Error(`Failed to save global config: ${error}`);
    }
  }

  /**
   * Load local/directory configuration
   */
  async load(): Promise<DirectoryConfig | null> {
    if (!this.workingDir) {
      return null;
    }

    try {
      const configPath = this.getLocalConfigPath();
      if (!(await pathExists(configPath))) {
        return null;
      }

      const content = await fs.readFile(configPath, "utf8");
      return JSON.parse(content) as DirectoryConfig;
    } catch (error) {
      // Failed to load local config
      return null;
    }
  }

  /**
   * Save local/directory configuration.
   *
   * Strips the deprecated v0 `subduction` field before writing so no
   * v1 config on disk carries both `protocol` and the legacy flag.
   */
  async save(config: DirectoryConfig): Promise<void> {
    if (!this.workingDir) {
      throw new Error("Working directory not set for local config");
    }

    try {
      const configPath = this.getLocalConfigPath();
      await ensureDirectoryExists(path.dirname(configPath));

      // Normalize before serialization: enforce v1 invariants.
      const { subduction: _legacy, ...clean } = config;
      const toWrite: DirectoryConfig = {
        ...clean,
        config_version: clean.config_version ?? CONFIG_VERSION,
      };

      const content = JSON.stringify(toWrite, null, 2);
      await fs.writeFile(configPath, content, "utf8");
    } catch (error) {
      throw new Error(`Failed to save local config: ${error}`);
    }
  }

  private getDefaultGlobalConfig(): GlobalConfig {
    // Global config doesn't specify a backend. sync_server is left
    // undefined; the per-directory config (or `resolveProtocol`'s
    // defaults) decides the endpoint. We seed the other fields.
    return {
      exclude_patterns: [
        ".git",
        "node_modules",
        "*.tmp",
        ".DS_Store",
        ".pushwork",
      ],
      artifact_directories: ["dist"],
      sync: {
        move_detection_threshold: 0.7,
      },
    };
  }

  /**
   * Get default directory configuration (v1, Subduction-by-default).
   *
   * Legacy-mode configs are constructed by callers via
   * `getDefaultDirectoryConfigForProtocol("legacy")`.
   */
  getDefaultDirectoryConfig(): DirectoryConfig {
    return this.getDefaultDirectoryConfigForProtocol("subduction");
  }

  /**
   * Get default directory configuration for a specific protocol.
   *
   * - "subduction": default endpoint, no storage_id
   * - "legacy":     classic WebSocket endpoint + storage_id
   */
  getDefaultDirectoryConfigForProtocol(
    protocol: SyncProtocol
  ): DirectoryConfig {
    const base: DirectoryConfig = {
      config_version: CONFIG_VERSION,
      protocol,
      sync_enabled: true,
      exclude_patterns: [
        ".git",
        "node_modules",
        "*.tmp",
        ".pushwork",
        ".DS_Store",
      ],
      artifact_directories: ["dist"],
      sync: {
        move_detection_threshold: 0.7,
      },
    };

    if (protocol === "subduction") {
      return { ...base, sync_server: DEFAULT_SUBDUCTION_SERVER };
    }
    return {
      ...base,
      sync_server: DEFAULT_SYNC_SERVER,
      sync_server_storage_id: DEFAULT_SYNC_SERVER_STORAGE_ID,
    };
  }

  /**
   * Get merged configuration (global + local).
   *
   * Picks the base defaults according to the effective protocol of the
   * local config (if any). This keeps the merged shape consistent with
   * the backend choice — a legacy local config gets a legacy base, so
   * `sync_server_storage_id` appears in the merged result.
   */
  async getMerged(): Promise<DirectoryConfig> {
    const globalConfig = await this.loadGlobal();
    const localConfig = await this.load();

    const protocol = resolveProtocol(localConfig);
    let merged = this.getDefaultDirectoryConfigForProtocol(protocol);

    if (globalConfig) {
      merged = this.mergeConfigs(merged, globalConfig);
    }

    if (localConfig) {
      merged = this.mergeConfigs(merged, localConfig);
    }

    // Normalize: on v1, `protocol` is authoritative; strip the legacy
    // `subduction` field from the in-memory shape so callers never see
    // both fields.
    if (merged.subduction !== undefined) {
      delete merged.subduction;
    }
    merged.protocol = protocol;

    return merged;
  }

  /**
   * Initialize with CLI option overrides.
   *
   * Creates a new v1 config with protocol-appropriate defaults and
   * saves it. The `protocol` in `overrides` (if set) picks the base.
   */
  async initializeWithOverrides(
    overrides: Partial<DirectoryConfig> = {}
  ): Promise<DirectoryConfig> {
    const protocol =
      overrides.protocol ?? resolveProtocol(overrides) ?? "subduction";
    const base = this.getDefaultDirectoryConfigForProtocol(protocol);
    const config = this.mergeConfigs(base, overrides);

    // Strip the legacy v0 field if it snuck in via overrides. `protocol`
    // is the v1 source of truth.
    if (config.subduction !== undefined) {
      delete config.subduction;
    }
    config.config_version = CONFIG_VERSION;
    config.protocol = protocol;

    await this.save(config);
    return config;
  }

  /**
   * Migrate a v0 config to v1 on disk, if needed.
   *
   * - Reads the raw local config.
   * - If absent or already v1, returns without action.
   * - If v0: backs up the original to `config.json.bak` (collision-safe
   *   via `pickAvailableBackupPath`), rewrites to v1 shape, saves, and
   *   returns metadata so callers can print a migration message.
   *
   * Intended for write-ish commands (init/clone/track/sync/watch/
   * commit). Read-only commands should not call this; they instead
   * read through `getMerged()` or `load()` + `resolveProtocol()`, which
   * handle v0 configs transparently in memory.
   */
  async migrateIfNeeded(): Promise<
    | { migrated: false }
    | {
        migrated: true;
        protocol: SyncProtocol;
        backupPath: string;
        configPath: string;
      }
  > {
    if (!this.workingDir) return { migrated: false };
    const configPath = this.getLocalConfigPath();
    if (!(await pathExists(configPath))) return { migrated: false };

    let raw: Partial<DirectoryConfig>;
    try {
      const content = await fs.readFile(configPath, "utf8");
      raw = JSON.parse(content) as Partial<DirectoryConfig>;
    } catch {
      // If the file is corrupt, don't try to migrate — let the load
      // path handle the error in its usual way.
      return { migrated: false };
    }

    // Forward compat: a future version we don't understand.
    if (
      raw.config_version !== undefined &&
      raw.config_version > CONFIG_VERSION
    ) {
      throw new Error(
        `Config schema version ${raw.config_version} is newer than this pushwork understands ` +
          `(supports up to v${CONFIG_VERSION}). Upgrade pushwork.`
      );
    }

    // Already current — nothing to do.
    if (raw.config_version === CONFIG_VERSION) return { migrated: false };

    // v0 → v1 migration.
    const protocol = resolveProtocol(raw);

    // 1. Write backup of the v0 file verbatim.
    const backupPath = await pickAvailableBackupPath(configPath);
    const originalContent = await fs.readFile(configPath, "utf8");
    await fs.writeFile(backupPath, originalContent, "utf8");

    // 2. Build the v1 shape. Start from protocol-appropriate defaults,
    //    then layer the user's v0 fields over top, then enforce v1
    //    invariants (config_version, protocol, no `subduction`).
    const migrated = this.mergeConfigs(
      this.getDefaultDirectoryConfigForProtocol(protocol),
      raw
    );
    if (migrated.subduction !== undefined) {
      delete migrated.subduction;
    }
    migrated.config_version = CONFIG_VERSION;
    migrated.protocol = protocol;

    // For legacy protocol: ensure the WebSocket endpoint + storage_id
    // survive. The user's explicit values take precedence; only fall
    // back to defaults if they were absent.
    if (protocol === "legacy") {
      if (!migrated.sync_server) migrated.sync_server = DEFAULT_SYNC_SERVER;
      if (!migrated.sync_server_storage_id) {
        migrated.sync_server_storage_id = DEFAULT_SYNC_SERVER_STORAGE_ID;
      }
    } else {
      // Subduction mode: storage_id is meaningless. Strip it.
      if (migrated.sync_server_storage_id !== undefined) {
        delete migrated.sync_server_storage_id;
      }
      if (!migrated.sync_server) {
        migrated.sync_server = DEFAULT_SUBDUCTION_SERVER;
      }
    }

    await this.save(migrated);
    return { migrated: true, protocol, backupPath, configPath };
  }

  /**
   * Merge two configuration objects
   */
  private mergeConfigs(
    base: DirectoryConfig,
    override: Partial<DirectoryConfig> | GlobalConfig
  ): DirectoryConfig {
    const merged = { ...base };
    const ov = override as Partial<DirectoryConfig>;

    if ("config_version" in ov && ov.config_version !== undefined) {
      merged.config_version = ov.config_version;
    }

    if ("sync_server" in ov && ov.sync_server !== undefined) {
      merged.sync_server = ov.sync_server;
    }

    if (
      "sync_server_storage_id" in ov &&
      ov.sync_server_storage_id !== undefined
    ) {
      merged.sync_server_storage_id = ov.sync_server_storage_id;
    }

    if ("protocol" in ov && ov.protocol !== undefined) {
      merged.protocol = ov.protocol;
    }

    // Legacy v0 field — still honored during merge so old configs
    // read cleanly. Normalized to `protocol` by `migrateIfNeeded`.
    if ("subduction" in ov && ov.subduction !== undefined) {
      merged.subduction = ov.subduction;
    }

    if ("sync_enabled" in ov && ov.sync_enabled !== undefined) {
      merged.sync_enabled = ov.sync_enabled;
    }

    if ("root_directory_url" in ov && ov.root_directory_url !== undefined) {
      merged.root_directory_url = ov.root_directory_url;
    }

    // Handle GlobalConfig-ish fields
    if ("exclude_patterns" in ov && ov.exclude_patterns) {
      merged.exclude_patterns = ov.exclude_patterns;
    }

    if ("artifact_directories" in ov && ov.artifact_directories) {
      merged.artifact_directories = ov.artifact_directories;
    }

    if ("sync" in ov && ov.sync) {
      merged.sync = { ...merged.sync, ...ov.sync };
    }

    return merged;
  }

  /**
   * Create default global configuration
   */
  async createDefaultGlobal(): Promise<void> {
    const defaultGlobal = this.getDefaultGlobalConfig();
    await this.saveGlobal(defaultGlobal);
  }

  /**
   * Check if global configuration exists
   */
  async globalConfigExists(): Promise<boolean> {
    return await pathExists(this.getGlobalConfigPath());
  }

  /**
   * Check if local configuration exists
   */
  async localConfigExists(): Promise<boolean> {
    if (!this.workingDir) return false;
    return await pathExists(this.getLocalConfigPath());
  }

  /**
   * Get configuration value by path (e.g., 'sync.move_detection_threshold')
   */
  async getValue(keyPath: string): Promise<any> {
    const config = await this.getMerged();

    const keys = keyPath.split(".");
    let value: any = config;

    for (const key of keys) {
      if (value && typeof value === "object" && key in value) {
        value = value[key];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Set configuration value by path
   */
  async setValue(keyPath: string, value: any): Promise<void> {
    const config = (await this.load()) || ({} as DirectoryConfig);

    const keys = keyPath.split(".");
    let current: any = config;

    // Navigate to the parent of the target key
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key];
    }

    // Set the value
    const finalKey = keys[keys.length - 1];
    current[finalKey] = value;

    await this.save(config);
  }

  /**
   * Validate configuration
   */
  validate(config: DirectoryConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (config.sync?.move_detection_threshold !== undefined) {
      if (
        config.sync.move_detection_threshold < 0 ||
        config.sync.move_detection_threshold > 1
      ) {
        errors.push("move_detection_threshold must be between 0 and 1");
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
