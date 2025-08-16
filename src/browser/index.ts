/**
 * Browser entry point for pushwork sync functionality
 */

export { BrowserFilesystemAdapter, browserFS } from "./filesystem-adapter";
export { BrowserSyncEngine, BrowserRepoFactory } from "./browser-sync-engine";
export type {
  BrowserFileHandle,
  BrowserDirectoryHandle,
  BrowserFileSystemEntry,
  BrowserSyncState,
  DirectoryPickerOptions,
} from "./types";

// Re-export core types that are useful for browser usage
export type {
  SyncResult,
  SyncSnapshot,
  FileDocument,
  DirectoryDocument,
} from "../types";

import "./globals";

/**
 * Create a browser-ready pushwork sync instance
 */
export async function createBrowserSync(
  options: {
    syncServerUrl?: string;
    syncServerStorageId?: string;
  } = {}
) {
  const { BrowserRepoFactory, BrowserSyncEngine } = await import(
    "./browser-sync-engine"
  );
  const { browserFS } = await import("./filesystem-adapter");

  const repo = await BrowserRepoFactory.create(
    options.syncServerUrl,
    options.syncServerStorageId
  );

  const syncEngine = new BrowserSyncEngine(repo, browserFS);

  return {
    syncEngine,
    filesystem: browserFS,
    repo,

    // Convenience methods
    async pickFolder() {
      return await syncEngine.initializeWithDirectoryPicker();
    },

    async sync(dryRun = false) {
      return await syncEngine.sync(dryRun);
    },

    async commit(dryRun = false) {
      return await syncEngine.commitLocal(dryRun);
    },

    async getStatus() {
      return await syncEngine.getStatus();
    },

    async setRootUrl(url: string) {
      return await syncEngine.setRootDirectoryUrl(url);
    },

    async getRootUrl() {
      return await syncEngine.getRootDirectoryUrl();
    },
  };
}

/**
 * Check if File System Access API is supported
 */
export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "showDirectoryPicker" in window &&
    "showFilePicker" in window
  );
}
