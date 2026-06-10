/**
 * Pushwork public library API.
 *
 * Bidirectional directory synchronization using Automerge CRDTs.
 *
 * NOTE: the CLI entry point (`./cli`) is intentionally NOT re-exported here.
 * `cli.ts` runs the command parser as a side effect when executed as the
 * `pushwork` bin; re-exporting it would make merely `import`ing this package
 * run the CLI against the host process's argv. Keep this module side-effect
 * free.
 *
 * This is a curated surface: the high-level types and entry points a consumer
 * needs. Internal helpers (text splicing, path/mime utilities, document
 * rebuild primitives, etc.) are not part of the public API but remain
 * reachable via deep imports (e.g. `pushwork/dist/utils/...`) if required.
 */

// --- Core: sync engine and supporting managers ---
export { SyncEngine } from "./core/sync-engine";
export { SnapshotManager } from "./core/snapshot";
export { ChangeDetector } from "./core/change-detection";
export { MoveDetector } from "./core/move-detection";

// --- Configuration ---
export {
  ConfigManager,
  resolveProtocol,
  pickAvailableBackupPath,
} from "./core/config";

// --- Repository factory (Automerge Repo construction + Subduction Wasm init) ---
export { createRepo } from "./utils/repo-factory";

// --- Types, enums, and constants ---
// FileDocument, DirectoryDocument, DirectoryConfig, SyncProtocol, SyncResult,
// FileType, ChangeType, CONFIG_VERSION, DEFAULT_*_SERVER, command-option
// interfaces, etc.
export * from "./types";
