/**
 * Browser-specific types for File System Access API compatibility
 */

// Add global types for File System Access API
declare global {
  interface Window {
    showDirectoryPicker(options?: any): Promise<any>;
    showFilePicker(options?: any): Promise<any>;
  }
}

// Type definitions for File System Access API
type PermissionState = "granted" | "denied" | "prompt";

interface FileSystemWritableFileStream extends WritableStream {
  write(data: any): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
  queryPermission(options?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;
  requestPermission(options?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;
}

export interface BrowserDirectoryHandle {
  kind: "directory";
  name: string;
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<BrowserFileHandle | BrowserDirectoryHandle>;
  entries(): AsyncIterableIterator<
    [string, BrowserFileHandle | BrowserDirectoryHandle]
  >;
  getFileHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<BrowserFileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<BrowserDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  queryPermission(options?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;
  requestPermission(options?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;
}

export interface BrowserFileSystemEntry {
  path: string;
  handle: BrowserFileHandle | BrowserDirectoryHandle;
  type: "file" | "directory";
  size?: number;
  lastModified?: Date;
}

export interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?:
    | "desktop"
    | "documents"
    | "downloads"
    | "music"
    | "pictures"
    | "videos";
}

export interface BrowserSyncState {
  rootHandle: BrowserDirectoryHandle | null;
  hasPermission: boolean;
  isSupported: boolean;
}
