import { Repo, StorageId } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import * as path from "path";
import chalk from "chalk";
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
    console.log(chalk.gray(`  ✓ Network sync enabled: ${syncServer}`));
  } else {
    console.log(chalk.gray("  ✓ Local-only mode (network sync disabled)"));
  }

  const repo = new Repo(repoConfig);

  // Subscribe to the sync server storage for network sync
  if (enableNetwork && syncServer && syncServerStorageId) {
    repo.subscribeToRemotes([syncServerStorageId as StorageId]);
    console.log(
      chalk.gray(
        `  ✓ Subscribed to sync server storage: ${syncServerStorageId}`
      )
    );
  }

  return repo;
}
