import { Repo, StorageId } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import * as path from "path";
import { DirectoryConfig } from "../types";

/**
 * Create an Automerge repository with configuration-based setup
 */
export async function createRepo(
  workingDir: string,
  config: DirectoryConfig
): Promise<Repo> {
  const syncToolDir = path.join(workingDir, ".pushwork");
  const storage = new NodeFSStorageAdapter(path.join(syncToolDir, "automerge"));

  const repoConfig: any = { storage };

  // Add network adapter only if sync is enabled and server is configured
  if (config.sync_enabled && config.sync_server) {
    const networkAdapter = new BrowserWebSocketClientAdapter(
      config.sync_server
    );
    repoConfig.network = [networkAdapter];
  }

  const repo = new Repo(repoConfig);

  // Subscribe to the sync server storage for network sync
  if (
    config.sync_enabled &&
    config.sync_server &&
    config.sync_server_storage_id
  ) {
    repo.subscribeToRemotes([config.sync_server_storage_id as StorageId]);
  }

  return repo;
}
