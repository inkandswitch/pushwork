import { AutomergeUrl } from "@automerge/automerge-repo";

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
}

/**
 * File document structure
 */
export interface FileDocument {
  "@patchwork": { type: "file" };
  name: string;
  extension: string;
  mimeType: string;
  contents: string | Uint8Array;
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
  confidence: "auto" | "prompt" | "low";
}
