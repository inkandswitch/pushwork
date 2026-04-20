import { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";

/**
 * Tracked file entry in the sync snapshot
 */
export interface SnapshotFileEntry {
  path: string; // Full filesystem path for mapping
  url: AutomergeUrl; // Automerge document URL
  head: UrlHeads; // Document head at last sync
  extension: string; // File extension
  mimeType: string; // MIME type
  contentHash?: string; // SHA-256 of content at last sync (used by artifact files to skip remote reads)
  /**
   * Number of consecutive syncs for which this path could not be
   * looked up on the remote (RemoteLookup returned `unavailable`).
   *
   * Reset to 0 on any successful `found` or `absent` lookup AND after
   * a successful pull that wrote this file's content locally.
   *
   * At 5, pushwork prints a prominent warning with recovery hints.
   * At 20, the sync is blocked with a hard error until the user
   * resolves via `pushwork rm-tracked <path>` or `pushwork resync <path>`.
   */
  consecutiveUnavailableCount?: number;
}

/**
 * Tracked directory entry in the sync snapshot
 */
export interface SnapshotDirectoryEntry {
  path: string; // Full filesystem path for mapping
  url: AutomergeUrl; // Automerge document URL
  head: UrlHeads; // Document head at last sync
  entries: string[]; // List of child entry names
}

/**
 * Sync snapshot for local state management
 */
export interface SyncSnapshot {
  timestamp: number;
  rootPath: string;
  rootDirectoryUrl?: AutomergeUrl; // URL of the root directory document
  files: Map<string, SnapshotFileEntry>;
  directories: Map<string, SnapshotDirectoryEntry>;
}

/**
 * Serializable version of sync snapshot for storage
 */
export interface SerializableSyncSnapshot {
  timestamp: number;
  rootPath: string;
  rootDirectoryUrl?: AutomergeUrl; // URL of the root directory document
  files: Array<[string, SnapshotFileEntry]>;
  directories: Array<[string, SnapshotDirectoryEntry]>;
}

/**
 * Sync operation result
 */
export interface SyncResult {
  success: boolean;
  filesChanged: number;
  directoriesChanged: number;
  errors: SyncError[];
  warnings: string[];
  timings?: { [key: string]: number };
}

/**
 * Sync error details
 */
export interface SyncError {
  path: string;
  operation: string;
  error: Error;
  recoverable: boolean;
}
