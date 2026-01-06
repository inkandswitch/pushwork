import { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";

/**
 * Entry in a directory document
 */
export interface DirectoryEntry {
  name: string;
  type: "file" | "folder";
  url: AutomergeUrl;
}

/**
 * Directory document structure
 */
export interface DirectoryDocument {
  "@patchwork": { type: "folder" };
  docs: DirectoryEntry[];
  lastSyncAt?: number; // Timestamp of last sync operation that made changes
}

/**
 * File document structure
 */
export interface FileDocument {
  "@patchwork": { type: "file" };
  name: string;
  extension: string;
  mimeType: string;
  content: string | Uint8Array;
  metadata: {
    permissions: number;
  };
}

/**
 * File type classification
 */
export enum FileType {
  TEXT = "text",
  BINARY = "binary",
  DIRECTORY = "directory",
}

/**
 * Change type classification for sync operations
 */
export enum ChangeType {
  NO_CHANGE = "no_change",
  LOCAL_ONLY = "local_only",
  REMOTE_ONLY = "remote_only",
  BOTH_CHANGED = "both_changed",
}

/**
 * File system entry metadata
 */
export interface FileSystemEntry {
  path: string;
  type: FileType;
  size: number;
  mtime: Date;
  permissions: number;
}

/**
 * Move detection result
 */
export interface MoveCandidate {
  fromPath: string;
  toPath: string;
  similarity: number;
  newContent?: string | Uint8Array; // Content at destination (may differ from source if modified during move)
}

/**
 * Represents a detected change
 */
export interface DetectedChange {
  path: string;
  changeType: ChangeType;
  fileType: FileType;
  localContent: string | Uint8Array | null;
  remoteContent: string | Uint8Array | null;
  localHead?: UrlHeads;
  remoteHead?: UrlHeads;
}
