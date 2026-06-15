import { StorageId } from "@automerge/automerge-repo";

/**
 * Default sync server configuration
 */
export const DEFAULT_SYNC_SERVER = "wss://sync3.automerge.org";
export const DEFAULT_SYNC_SERVER_STORAGE_ID =
  "3760df37-a4c6-4f66-9ecd-732039a9385d" as StorageId;
export const DEFAULT_SUBDUCTION_SERVER = "wss://subduction.sync.inkandswitch.com";

/**
 * Default gitignore-style patterns excluded from sync.
 *
 * These are directories and files that are machine-generated,
 * downloadable, or otherwise not worth syncing as CRDT documents —
 * dependency stores, build output, and tool caches across the common
 * language ecosystems. Each one can be hundreds of MB to multiple GB
 * (pnpm's content-addressed `.pnpm-store`, Rust's `target`, a Python
 * `.venv`, …), so syncing them is both pointless and a severe
 * performance hazard: every file becomes an Automerge document.
 *
 * Matched with full `.gitignore` semantics (via the `ignore` library),
 * so a bare name like `target` matches at any depth. Users can override
 * the whole list per-directory via `exclude_patterns` in
 * `.pushwork/config.json` (note: `sync` runs in force mode and resets to
 * these defaults; use `sync --gentle` to honor a customized list).
 */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  // Version control
  ".git",
  ".hg",
  ".jj",
  ".svn",

  // OS & editor cruft
  "*.swp",
  "*.tmp",
  "*~",
  ".DS_Store",
  "Thumbs.db",

  // pushwork's own metadata
  ".pushwork",

  // Node / JavaScript dependencies & caches
  ".npm",
  ".parcel-cache",
  ".pnpm-store",
  ".turbo",
  ".yarn/cache",
  ".yarn/unplugged",
  "bower_components",
  "node_modules",

  // JS framework build caches
  ".astro",
  ".next",
  ".nuxt",
  ".svelte-kit",

  // Python
  "*.egg-info",
  "*.pyc",
  ".ipynb_checkpoints",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "venv",

  // Rust & JVM (Maven `target`, Gradle `.gradle`)
  ".gradle",
  "target",

  // Elixir / Erlang
  "_build",

  // Haskell
  ".stack-work",
  "dist-newstyle",

  // Nix build results
  "result",
  "result-*",

  // Misc tool caches
  ".nyc_output",
  ".terraform",
];

/**
 * Default artifact directories.
 *
 * Unlike `exclude_patterns`, artifact directories *are* synced — but
 * their files are treated as immutable snapshots (stored as RawString
 * rather than collaborative text) and replaced wholesale rather than
 * diffed. See CLAUDE.md "Performance pitfalls".
 */
export const DEFAULT_ARTIFACT_DIRECTORIES: readonly string[] = ["dist"];

/**
 * Current schema version for persisted `.pushwork/config.json`.
 *
 * Bumped whenever the on-disk format changes in a way that needs
 * explicit migration. The migration logic lives in `core/config.ts`
 * (`resolveProtocol`, `migrateIfNeeded`). See CLAUDE.md for history.
 *
 * Versions:
 *   - v0 (absent field): pre-Subduction-default configs. Had a
 *     `subduction?: boolean` field (opt-in flag). Absence of that
 *     field meant legacy WebSocket sync.
 *   - v1: Subduction is the default backend. The field is now
 *     `protocol: "subduction" | "legacy"`, always written explicitly.
 *     `--legacy` opts into classic WebSocket sync.
 */
export const CONFIG_VERSION = 1;

/**
 * Sync protocol identifier. Extensible: future protocols can be added
 * as additional string literals (e.g. `"bluesky"`).
 */
export type SyncProtocol = "subduction" | "legacy";

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
  /**
   * Config schema version. Absent ⇒ v0 (pre-flip). Written explicitly
   * as `CONFIG_VERSION` on any config this pushwork creates.
   */
  config_version?: number;
  root_directory_url?: string;
  /**
   * Which sync backend this directory uses. Always present on v1
   * configs. On v0 configs this is absent — use `resolveProtocol()`
   * (which also inspects the legacy `subduction` field) to derive it.
   */
  protocol?: SyncProtocol;
  /**
   * @deprecated v0-only field. On v1 configs, use `protocol` instead.
   * Kept in the type only to let `resolveProtocol()` inspect v0
   * configs during migration.
   */
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
  /**
   * Use the legacy WebSocket sync backend. When absent or false,
   * Subduction (the default) is used.
   */
  legacy?: boolean;
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
  /**
   * Use the legacy WebSocket sync backend. When absent or false,
   * Subduction (the default) is used.
   */
  legacy?: boolean;
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
