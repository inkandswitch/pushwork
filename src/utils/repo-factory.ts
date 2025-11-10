import { Repo, StorageId } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import * as path from "path";
import { ConfigManager } from "../config";

export interface RepoFactoryOptions {
  enableNetwork?: boolean;
  syncServer?: string;
  syncServerStorageId?: string;
}

/**
 * Create an Automerge repository with configuration-based setup
 */
export async function createRepo(
  workingDir: string,
  options: RepoFactoryOptions = {}
): Promise<Repo> {
  const configManager = new ConfigManager(workingDir);
  const config = await configManager.getMerged();

  const syncToolDir = path.join(workingDir, ".pushwork");
  const storage = new NodeFSStorageAdapter(path.join(syncToolDir, "automerge"));

  const repoConfig: any = { storage };

  // Determine network settings - options override config
  const enableNetwork = options.enableNetwork ?? true;
  const syncServer = options.syncServer ?? config.sync_server;
  const syncServerStorageId =
    options.syncServerStorageId ?? config.sync_server_storage_id;

  // Add network adapter only if explicitly enabled and sync server is configured
  if (enableNetwork && syncServer) {
    const networkAdapter = new BrowserWebSocketClientAdapter(syncServer);
    repoConfig.network = [networkAdapter];
    repoConfig.enableRemoteHeadsGossiping = true;
  }

  const repo = new Repo(repoConfig);

  // Subscribe to the sync server storage for network sync
  if (enableNetwork && syncServer && syncServerStorageId) {
    repo.subscribeToRemotes([syncServerStorageId as StorageId]);
  }

  // Suppress Automerge internal debug output unless explicitly enabled
  if (!process.env.PUSHWORK_DEBUG) {
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      const str = args[0]?.toString() || "";
      // Filter out Automerge internal messages and sync progress
      if (
        str.includes("emitting") ||
        str.includes("lastSyncAt") ||
        str.includes("Updated root directory") ||
        str.includes("🔄") ||
        str.includes("⬇️") ||
        str.includes("🔀") ||
        str.includes("Syncing")
      ) {
        return;
      }
      originalLog(...args);
    };
  }

  return repo;
}
