import { StorageId } from "@automerge/automerge-repo";

/**
 * Default sync server configuration
 */
export const DEFAULT_SYNC_SERVER = "wss://sync3.automerge.org";
export const DEFAULT_SYNC_SERVER_STORAGE_ID =
  "3760df37-a4c6-4f66-9ecd-732039a9385d" as StorageId;
export const DEFAULT_SUBDUCTION_SERVER = "wss://subduction.sync.inkandswitch.com";

/**
 * Global configuration options
 */
export interface GlobalConfig {
  sync_server?: string;
  sync_server_storage_id?: StorageId;
  exclude_patterns: string[];
  artifact_directories: string[];
  sync: {
    move_detection_threshold: number;
  };
}

/**
 * Per-directory configuration
 */
export interface DirectoryConfig extends GlobalConfig {
  root_directory_url?: string;
  subduction?: boolean;
  sync_enabled: boolean;
}

/**
 * CLI command options
 */
export interface CommandOptions {
  verbose?: boolean;
}

/**
 * Clone command specific options
 */
export interface CloneOptions extends CommandOptions {
  force?: boolean; // Overwrite existing directory
  syncServer?: string; // Custom sync server URL
  syncServerStorageId?: StorageId; // Custom sync server storage ID
  /** @deprecated Subduction is default; use `websocket: true` for legacy sync3. */
  sub?: boolean;
  /** Use legacy WebSocket sync (sync3) instead of Subduction. */
  websocket?: boolean;
}

/**
 * Sync command specific options
 */
export interface SyncOptions extends CommandOptions {
  force?: boolean;
  nuclear?: boolean;
  gentle?: boolean;
  dryRun?: boolean;
}

/**
 * Diff command specific options
 */
export interface DiffOptions extends CommandOptions {
  nameOnly: boolean;
}

/**
 * Log command specific options
 */
export interface LogOptions extends CommandOptions {
  oneline: boolean;
  since?: string;
  limit?: number;
}

/**
 * Checkout command specific options
 */
export interface CheckoutOptions extends CommandOptions {
  force?: boolean;
}

/**
 * Init command specific options
 */
export interface InitOptions extends CommandOptions {
  syncServer?: string;
  syncServerStorageId?: StorageId;
  /** @deprecated Subduction is default; use `websocket: true` for legacy sync3. */
  sub?: boolean;
  /** Use legacy WebSocket sync (sync3) instead of Subduction. */
  websocket?: boolean;
}

/**
 * Config command specific options
 */
export interface ConfigOptions extends CommandOptions {
  list?: boolean;
  get?: string;
  set?: string;
  value?: string;
}

/**
 * Status command specific options
 */
export interface StatusOptions extends CommandOptions {
  verbose?: boolean;
}

/**
 * Watch command specific options
 */
export interface WatchOptions extends CommandOptions {
  script?: string; // Script to run before syncing
  watchDir?: string; // Directory to watch (relative to working dir)
}

/**
 * Whether to use the Subduction sync backend for this config.
 * New projects default to Subduction. Legacy WebSocket projects set
 * `subduction: false` or use a sync3 URL / storage id without `subduction: true`.
 */
export function useSubductionBackend(
  config: Pick<DirectoryConfig, "subduction" | "sync_server" | "sync_server_storage_id">,
): boolean {
  if (config.subduction === true) return true;
  if (config.subduction === false) return false;
  // Legacy .pushwork/config.json without a subduction field
  if (config.sync_server === DEFAULT_SYNC_SERVER) return false;
  if (config.sync_server_storage_id !== undefined) return false;
  return true;
}

/** CLI backend selection: Subduction by default; `--websocket` or deprecated `sub: false` selects sync3. */
export function subductionFromCliFlags(flags: {
  websocket?: boolean;
  /** @deprecated Use `websocket: true` instead of `sub: false`. */
  sub?: boolean;
}): boolean {
  if (flags.websocket) return false;
  if (flags.sub === false) return false;
  if (flags.sub === true) return true;
  return true;
}
