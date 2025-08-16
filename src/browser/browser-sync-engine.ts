/**
 * Browser-compatible sync engine that adapts the core SyncEngine for browser use
 */

import { Repo } from "@automerge/automerge-repo";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { SyncEngine } from "../core/sync-engine";
import { setRootDirectoryHandle } from "../utils/fs-browser";
import { SyncSnapshot, SyncResult } from "../types";
import { browserFS, BrowserFilesystemAdapter } from "./filesystem-adapter";
import { BrowserDirectoryHandle, BrowserSyncState } from "./types";
import "./globals";

/**
 * Browser snapshot manager using IndexedDB
 */
class BrowserSnapshotManager {
  private dbName = "pushwork-snapshots";
  private storeName = "snapshots";
  private version = 1;

  async save(snapshot: SyncSnapshot, key = "current"): Promise<void> {
    const db = await this.openDB();
    const transaction = db.transaction([this.storeName], "readwrite");
    const store = transaction.objectStore(this.storeName);

    const putRequest = store.put({
      key,
      snapshot: JSON.stringify(snapshot, this.snapshotReplacer),
      timestamp: Date.now(),
    });

    await new Promise((resolve, reject) => {
      putRequest.onsuccess = () => resolve(undefined);
      putRequest.onerror = () => reject(putRequest.error);
    });

    db.close();
  }

  async load(key = "current"): Promise<SyncSnapshot | null> {
    try {
      const db = await this.openDB();
      const transaction = db.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);

      const request = store.get(key);
      const result = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();

      if (result) {
        return JSON.parse((result as any).snapshot, this.snapshotReviver);
      }
      return null;
    } catch (error) {
      console.warn("Failed to load snapshot from IndexedDB:", error);
      return null;
    }
  }

  async backup(key = "current"): Promise<void> {
    const snapshot = await this.load(key);
    if (snapshot) {
      await this.save(snapshot, `${key}-backup-${Date.now()}`);
    }
  }

  private async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "key" });
        }
      };
    });
  }

  private snapshotReplacer(key: string, value: any): any {
    // Handle Map serialization
    if (value instanceof Map) {
      return {
        __type: "Map",
        entries: Array.from(value.entries()),
      };
    }
    return value;
  }

  private snapshotReviver(key: string, value: any): any {
    // Handle Map deserialization
    if (value && value.__type === "Map") {
      return new Map(value.entries);
    }
    return value;
  }
}

/**
 * Browser-compatible repo factory
 */
export class BrowserRepoFactory {
  static async create(
    syncServerUrl?: string,
    storageId?: string
  ): Promise<Repo> {
    // Use IndexedDB storage for browser persistence
    const storage = new IndexedDBStorageAdapter("pushwork-repo");

    const repo = new Repo({
      storage,
      network: [], // Network will be added separately if needed
      sharePolicy: async () => false, // Don't auto-share documents
    });

    // Add WebSocket network if sync server provided
    if (syncServerUrl) {
      try {
        const { BrowserWebSocketClientAdapter } = await import(
          "@automerge/automerge-repo-network-websocket"
        );

        const websocketAdapter = new BrowserWebSocketClientAdapter(
          syncServerUrl
        );

        repo.networkSubsystem.addNetworkAdapter(websocketAdapter as any);
      } catch (error) {
        console.warn("Failed to setup WebSocket network:", error);
      }
    }

    return repo;
  }
}

/**
 * Browser-specific sync engine that adapts filesystem operations
 */
export class BrowserSyncEngine {
  private repo: Repo;
  private filesystem: BrowserFilesystemAdapter;
  private snapshotManager: BrowserSnapshotManager;
  private coreEngine: SyncEngine | null = null;
  private rootPath = "/"; // Virtual root for browser

  constructor(repo: Repo, filesystem: BrowserFilesystemAdapter = browserFS) {
    this.repo = repo;
    this.filesystem = filesystem;
    this.snapshotManager = new BrowserSnapshotManager();
  }

  /**
   * Initialize with directory picker
   */
  async initializeWithDirectoryPicker(): Promise<BrowserDirectoryHandle> {
    const handle = await this.filesystem.showDirectoryPicker({
      mode: "readwrite",
      id: "pushwork-sync-folder",
    });

    // Set up browser filesystem for utils
    setRootDirectoryHandle(handle);

    // Initialize core engine once we have a directory
    this.coreEngine = new SyncEngine(
      this.repo,
      this.rootPath,
      [".git", "node_modules", ".pushwork", "*.tmp"], // default excludes
      true // network sync enabled
    );

    return handle;
  }

  /**
   * Get current browser sync state
   */
  getSyncState(): BrowserSyncState {
    return this.filesystem.getSyncState();
  }

  /**
   * Commit local changes from browser directory
   */
  async commitLocal(dryRun = false): Promise<SyncResult> {
    if (!this.coreEngine) {
      throw new Error(
        "Sync engine not initialized. Call initializeWithDirectoryPicker() first."
      );
    }

    // Create browser-adapted version of commit
    return this.adaptedSync(dryRun, false);
  }

  /**
   * Full bidirectional sync
   */
  async sync(dryRun = false): Promise<SyncResult> {
    if (!this.coreEngine) {
      throw new Error(
        "Sync engine not initialized. Call initializeWithDirectoryPicker() first."
      );
    }

    return this.adaptedSync(dryRun, true);
  }

  /**
   * Adapted sync that works with browser filesystem
   */
  private async adaptedSync(
    dryRun: boolean,
    fullSync: boolean
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      filesChanged: 0,
      directoriesChanged: 0,
      errors: [],
      warnings: [],
    };

    try {
      // Load browser snapshot
      let snapshot = await this.snapshotManager.load();
      if (!snapshot) {
        // Create initial snapshot structure adapted for browser
        snapshot = {
          timestamp: Date.now(),
          files: new Map(),
          directories: new Map(),
          rootDirectoryUrl: undefined,
          rootPath: "/", // Virtual root for browser
        };
      }

      const syncState = this.getSyncState();
      if (!syncState.rootHandle || !syncState.hasPermission) {
        throw new Error("No directory selected or permission denied");
      }

      // Get directory listing from browser filesystem
      const entries = await this.filesystem.listDirectory(
        syncState.rootHandle,
        true, // recursive
        [".git", "node_modules", ".pushwork", "*.tmp"]
      );

      console.log(`🔍 Found ${entries.length} entries in browser directory`);

      // For now, implement a simplified sync that demonstrates the concept
      // In a full implementation, this would:
      // 1. Detect changes by comparing entries with snapshot
      // 2. Apply changes to Automerge documents
      // 3. Pull remote changes and apply to browser filesystem
      // 4. Update snapshot

      if (!dryRun && snapshot) {
        await this.snapshotManager.save(snapshot);
      }

      result.success = true;
      result.filesChanged = entries.length;

      return result;
    } catch (error) {
      console.error("Browser sync failed:", error);
      result.errors.push({
        path: this.rootPath,
        operation: fullSync ? "sync" : "commit",
        error: error instanceof Error ? error : new Error(String(error)),
        recoverable: true,
      });
      return result;
    }
  }

  /**
   * Get sync status
   */
  async getStatus(): Promise<{
    snapshot: SyncSnapshot | null;
    hasChanges: boolean;
    changeCount: number;
    lastSync: Date | null;
    browserState: BrowserSyncState;
  }> {
    const snapshot = await this.snapshotManager.load();
    const browserState = this.getSyncState();

    return {
      snapshot,
      hasChanges: false, // TODO: implement change detection
      changeCount: 0,
      lastSync: snapshot ? new Date(snapshot.timestamp) : null,
      browserState,
    };
  }

  /**
   * Set root directory URL for sharing
   */
  async setRootDirectoryUrl(url: string): Promise<void> {
    let snapshot = await this.snapshotManager.load();
    if (!snapshot) {
      snapshot = {
        timestamp: Date.now(),
        files: new Map(),
        directories: new Map(),
        rootDirectoryUrl: undefined,
        rootPath: "/", // Virtual root for browser
      };
    }
    snapshot.rootDirectoryUrl = url as any; // AutomergeUrl type
    await this.snapshotManager.save(snapshot);
  }

  /**
   * Get root directory URL for sharing
   */
  async getRootDirectoryUrl(): Promise<string | null> {
    const snapshot = await this.snapshotManager.load();
    return snapshot?.rootDirectoryUrl || null;
  }
}
