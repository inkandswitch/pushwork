/**
 * Global configuration options
 */
export interface GlobalConfig {
  sync_server?: string;
  sync_server_storage_id?: string;
  exclude_patterns?: string[];
  large_file_threshold?: string;
  diff?: {
    external_tool?: string;
    show_binary?: boolean;
  };
  sync?: {
    move_detection_threshold?: number;
    prompt_threshold?: number;
    auto_sync?: boolean;
    parallel_operations?: number;
  };
}

/**
 * Diff tool settings
 */
export interface DiffSettings {
  external_tool?: string;
  show_binary: boolean;
}

/**
 * Sync behavior settings
 */
export interface SyncSettings {
  move_detection_threshold: number;
  prompt_threshold: number;
  auto_sync: boolean;
  parallel_operations: number;
}

/**
 * Per-directory configuration
 */
export interface DirectoryConfig {
  sync_server?: string;
  sync_server_storage_id?: string;
  sync_enabled: boolean;
  root_directory_url?: string; // AutomergeUrl of the root directory document
  defaults: {
    exclude_patterns: string[];
    large_file_threshold: string;
  };
  diff: {
    external_tool?: string;
    show_binary: boolean;
  };
  sync: {
    move_detection_threshold: number;
    prompt_threshold: number;
    auto_sync: boolean;
    parallel_operations: number;
  };
}

/**
 * CLI command options
 */
export interface CommandOptions {
  dryRun?: boolean;
  verbose?: boolean;
  debug?: boolean;
  tool?: string;
  nameOnly?: boolean;
  oneline?: boolean;
  remote?: string;
}

/**
 * Clone command specific options
 */
export interface CloneOptions extends CommandOptions {
  force?: boolean; // Overwrite existing directory
  syncServer?: string; // Custom sync server URL
  syncServerStorageId?: string; // Custom sync server storage ID
}

/**
 * Sync command specific options
 */
export interface SyncOptions extends CommandOptions {
  force?: boolean;
}

/**
 * Diff command specific options
 */
export interface DiffOptions extends CommandOptions {
  tool?: string;
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
  syncServerStorageId?: string;
}

/**
 * Commit command specific options
 */
export interface CommitOptions extends CommandOptions {}

/**
 * List (ls) command specific options
 */
export interface ListOptions extends CommandOptions {
  long?: boolean;
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
 * Debug command specific options
 */
export interface DebugOptions extends CommandOptions {
  verbose?: boolean;
}
