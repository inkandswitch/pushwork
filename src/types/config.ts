/**
 * Default sync server configuration
 */
export const DEFAULT_SYNC_SERVER = "wss://subduction.sync.inkandswitch.com";

/**
 * Global configuration options
 */
export interface GlobalConfig {
  sync_server?: string;
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
 * Read command specific options
 */
export interface ReadOptions extends CommandOptions {
  remote?: boolean; // Read from sync server instead of local storage
}
