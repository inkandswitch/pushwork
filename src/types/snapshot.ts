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

/**
 * Sync operation type
 */
export enum SyncOperation {
  CREATE_FILE = "create_file",
  UPDATE_FILE = "update_file",
  DELETE_FILE = "delete_file",
  MOVE_FILE = "move_file",
  CREATE_DIRECTORY = "create_directory",
  DELETE_DIRECTORY = "delete_directory",
  MOVE_DIRECTORY = "move_directory",
}

/**
 * Pending sync operation
 */
export interface PendingSyncOperation {
  operation: SyncOperation;
  path: string;
  newPath?: string;
  priority: number;
}
