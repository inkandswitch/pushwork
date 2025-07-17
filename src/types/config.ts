/**
 * Global configuration options
 */
export interface GlobalConfig {
  sync_server?: string;
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
 * Default settings
 */
export interface DefaultSettings {
  remote_repo?: string;
  exclude_patterns: string[];
  large_file_threshold: string;
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
  sync_enabled: boolean;
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
  tool?: string;
  nameOnly?: boolean;
  oneline?: boolean;
  remote?: string;
}

/**
 * Init command specific options
 */
export interface InitOptions extends CommandOptions {
  // No additional options needed - init creates a new sync directory
}

/**
 * Clone command specific options
 */
export interface CloneOptions extends CommandOptions {
  force?: boolean; // Overwrite existing directory
}

/**
 * Sync command specific options
 */
export interface SyncOptions extends CommandOptions {
  dryRun: boolean;
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
