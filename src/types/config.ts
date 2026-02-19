import { StorageId } from "@automerge/automerge-repo";

/**
 * Default sync server configuration
 */
export const DEFAULT_SYNC_SERVER = "wss://sync3.automerge.org";
export const DEFAULT_SYNC_SERVER_STORAGE_ID =
  "3760df37-a4c6-4f66-9ecd-732039a9385d" as StorageId;

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
}

/**
 * Sync command specific options
 */
export interface SyncOptions extends CommandOptions {
  force?: boolean;
  nuclear?: boolean;
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
