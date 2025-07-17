import * as path from "path";
import * as fs from "fs/promises";
import { Repo } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { NodeWSServerAdapter } from "@automerge/automerge-repo-network-websocket";
import chalk from "chalk";
import ora from "ora";
import {
  InitOptions,
  SyncOptions,
  DiffOptions,
  LogOptions,
  CheckoutOptions,
  DirectoryConfig,
} from "../types";
import { SyncEngine } from "../core";
import { pathExists, ensureDirectoryExists } from "../utils";
import { ConfigManager } from "../config";

/**
 * Create Automerge repo with network connectivity
 */
function createRepo(syncToolDir: string, syncServer?: string): Repo {
  const storage = new NodeFSStorageAdapter(path.join(syncToolDir, "automerge"));

  const repoConfig: any = { storage };

  // Add network adapter if sync server is configured
  if (syncServer) {
    const networkAdapter = new NodeWSServerAdapter(syncServer);
    repoConfig.network = [networkAdapter];
  }

  return new Repo(repoConfig);
}

/**
 * Initialize sync in a directory
 */
export async function init(
  targetPath: string,
  options: InitOptions
): Promise<void> {
  const spinner = ora("Initializing sync...").start();

  try {
    const resolvedPath = path.resolve(targetPath);

    // Ensure target directory exists
    await ensureDirectoryExists(resolvedPath);

    // Check if already initialized
    const syncToolDir = path.join(resolvedPath, ".sync-tool");
    if (await pathExists(syncToolDir)) {
      spinner.fail("Directory already initialized for sync");
      return;
    }

    // Create .sync-tool directory
    await ensureDirectoryExists(syncToolDir);

    // Create local configuration
    const configManager = new ConfigManager(resolvedPath);
    const config: DirectoryConfig = {
      remote_repo: options.remote,
      sync_server: "wss://sync3.automerge.org",
      sync_enabled: true,
      defaults: {
        exclude_patterns: [".git", "node_modules", "*.tmp"],
        large_file_threshold: "100MB",
      },
      diff: {
        show_binary: false,
      },
      sync: {
        move_detection_threshold: 0.8,
        prompt_threshold: 0.5,
        auto_sync: false,
        parallel_operations: 4,
      },
    };
    await configManager.save(config);

    // Initialize Automerge repo
    const repo = createRepo(syncToolDir, config.sync_server);

    // Initialize sync engine and create initial snapshot
    const syncEngine = new SyncEngine(repo, resolvedPath);
    await syncEngine.sync(false); // Initial sync to create snapshot

    spinner.succeed(`Initialized sync in ${chalk.green(resolvedPath)}`);
    console.log(`Remote repository: ${chalk.blue(options.remote)}`);
  } catch (error) {
    spinner.fail(`Failed to initialize: ${error}`);
    throw error;
  }
}

/**
 * Run bidirectional sync
 */
export async function sync(options: SyncOptions): Promise<void> {
  const spinner = ora("Running sync...").start();

  try {
    const currentPath = process.cwd();

    // Check if initialized
    const syncToolDir = path.join(currentPath, ".sync-tool");
    if (!(await pathExists(syncToolDir))) {
      spinner.fail(
        'Directory not initialized for sync. Run "sync-tool init" first.'
      );
      return;
    }

    // Load configuration
    const syncConfigManager = new ConfigManager(currentPath);
    const syncConfig = await syncConfigManager.load();

    if (!syncConfig?.remote_repo) {
      spinner.fail("No remote repository configured");
      return;
    }

    // Initialize Automerge repo
    const repo = createRepo(syncToolDir, syncConfig?.sync_server);

    // Run sync
    const syncEngine = new SyncEngine(repo, currentPath);

    if (options.dryRun) {
      spinner.text = "Previewing changes...";
      const preview = await syncEngine.previewChanges();

      spinner.succeed("Sync preview completed");

      console.log("\n" + chalk.bold("Changes to be synced:"));
      console.log(preview.summary);

      if (preview.changes.length > 0) {
        console.log("\n" + chalk.bold("Files:"));
        for (const change of preview.changes) {
          const typeColor =
            change.changeType === "local_only"
              ? chalk.green
              : change.changeType === "remote_only"
              ? chalk.blue
              : change.changeType === "both_changed"
              ? chalk.yellow
              : chalk.gray;
          console.log(`  ${typeColor(change.changeType)}: ${change.path}`);
        }
      }

      if (preview.moves.length > 0) {
        console.log("\n" + chalk.bold("Potential moves:"));
        for (const move of preview.moves) {
          const confidence =
            move.confidence === "auto"
              ? chalk.green(move.confidence)
              : move.confidence === "prompt"
              ? chalk.yellow(move.confidence)
              : chalk.red(move.confidence);
          console.log(`  ${move.fromPath} → ${move.toPath} (${confidence})`);
        }
      }
    } else {
      const result = await syncEngine.sync(false);

      if (result.success) {
        spinner.succeed(`Sync completed: ${result.filesChanged} files changed`);

        if (result.warnings.length > 0) {
          console.log("\n" + chalk.yellow("Warnings:"));
          for (const warning of result.warnings) {
            console.log(`  ${warning}`);
          }
        }
      } else {
        spinner.fail("Sync completed with errors");

        for (const error of result.errors) {
          console.log(chalk.red(`  ${error.path}: ${error.error.message}`));
        }
      }
    }
  } catch (error) {
    spinner.fail(`Sync failed: ${error}`);
    throw error;
  }
}

/**
 * Show differences between local and remote
 */
export async function diff(
  targetPath = ".",
  options: DiffOptions
): Promise<void> {
  try {
    const resolvedPath = path.resolve(targetPath);

    // Check if initialized
    const syncToolDir = path.join(resolvedPath, ".sync-tool");
    if (!(await pathExists(syncToolDir))) {
      console.log(chalk.red("Directory not initialized for sync"));
      return;
    }

    // Load configuration
    const diffConfigManager = new ConfigManager(resolvedPath);
    const diffConfig = await diffConfigManager.load();

    // Initialize Automerge repo
    const repo = createRepo(syncToolDir, diffConfig?.sync_server);

    // Get changes
    const syncEngine = new SyncEngine(repo, resolvedPath);
    const preview = await syncEngine.previewChanges();

    if (options.nameOnly) {
      // Show only file names
      for (const change of preview.changes) {
        console.log(change.path);
      }
      return;
    }

    if (preview.changes.length === 0) {
      console.log(chalk.green("No changes detected"));
      return;
    }

    console.log(chalk.bold("Differences:"));

    for (const change of preview.changes) {
      const typeLabel =
        change.changeType === "local_only"
          ? chalk.green("[LOCAL]")
          : change.changeType === "remote_only"
          ? chalk.blue("[REMOTE]")
          : change.changeType === "both_changed"
          ? chalk.yellow("[CONFLICT]")
          : chalk.gray("[NO CHANGE]");

      console.log(`${typeLabel} ${change.path}`);

      // TODO: Show actual diff content if external tool not specified
      if (options.tool) {
        console.log(`  Use "${options.tool}" to view detailed diff`);
      }
    }
  } catch (error) {
    console.error(chalk.red(`Diff failed: ${error}`));
    throw error;
  }
}

/**
 * Show sync status
 */
export async function status(): Promise<void> {
  try {
    const currentPath = process.cwd();

    // Check if initialized
    const syncToolDir = path.join(currentPath, ".sync-tool");
    if (!(await pathExists(syncToolDir))) {
      console.log(chalk.red("Directory not initialized for sync"));
      return;
    }

    // Initialize Automerge repo
    const statusConfigManager = new ConfigManager(currentPath);
    const statusConfig = await statusConfigManager.load();
    const repo = createRepo(syncToolDir, statusConfig?.sync_server);

    // Get status
    const syncEngine = new SyncEngine(repo, currentPath);
    const syncStatus = await syncEngine.getStatus();

    console.log(chalk.bold("Sync Status:"));
    console.log(`  Directory: ${chalk.blue(currentPath)}`);

    if (syncStatus.lastSync) {
      console.log(
        `  Last sync: ${chalk.green(syncStatus.lastSync.toISOString())}`
      );
    } else {
      console.log(`  Last sync: ${chalk.yellow("Never")}`);
    }

    if (syncStatus.hasChanges) {
      console.log(`  Pending changes: ${chalk.yellow(syncStatus.changeCount)}`);
    } else {
      console.log(`  Pending changes: ${chalk.green("None")}`);
    }

    // Load configuration
    const statusConfigManager2 = new ConfigManager(currentPath);
    const statusConfig2 = await statusConfigManager2.load();

    if (statusConfig2?.remote_repo) {
      console.log(
        `  Remote repository: ${chalk.blue(statusConfig2.remote_repo)}`
      );
    }

    if (statusConfig2?.sync_server) {
      console.log(`  Sync server: ${chalk.blue(statusConfig2.sync_server)}`);
    }
  } catch (error) {
    console.error(chalk.red(`Status failed: ${error}`));
    throw error;
  }
}

/**
 * Show sync history
 */
export async function log(
  targetPath = ".",
  options: LogOptions
): Promise<void> {
  try {
    const resolvedPath = path.resolve(targetPath);

    // Check if initialized
    const syncToolDir = path.join(resolvedPath, ".sync-tool");
    if (!(await pathExists(syncToolDir))) {
      console.log(chalk.red("Directory not initialized for sync"));
      return;
    }

    // TODO: Implement history tracking and display
    // For now, show basic information

    console.log(chalk.bold("Sync History:"));

    // Check for snapshot files
    const snapshotPath = path.join(syncToolDir, "snapshot.json");
    if (await pathExists(snapshotPath)) {
      const stats = await fs.stat(snapshotPath);

      if (options.oneline) {
        console.log(`${stats.mtime.toISOString()} - Last sync`);
      } else {
        console.log(`Last sync: ${chalk.green(stats.mtime.toISOString())}`);
        console.log(`Snapshot size: ${stats.size} bytes`);
      }
    } else {
      console.log(chalk.yellow("No sync history found"));
    }
  } catch (error) {
    console.error(chalk.red(`Log failed: ${error}`));
    throw error;
  }
}

/**
 * Checkout/restore from previous sync
 */
export async function checkout(
  syncId: string,
  targetPath = ".",
  options: CheckoutOptions
): Promise<void> {
  try {
    const resolvedPath = path.resolve(targetPath);

    // Check if initialized
    const syncToolDir = path.join(resolvedPath, ".sync-tool");
    if (!(await pathExists(syncToolDir))) {
      console.log(chalk.red("Directory not initialized for sync"));
      return;
    }

    // TODO: Implement checkout functionality
    // This would involve:
    // 1. Finding the sync with the given ID
    // 2. Restoring file states from that sync
    // 3. Updating the snapshot

    console.log(chalk.yellow(`Checkout functionality not yet implemented`));
    console.log(`Would restore to sync: ${syncId}`);
    console.log(`Target path: ${resolvedPath}`);
  } catch (error) {
    console.error(chalk.red(`Checkout failed: ${error}`));
    throw error;
  }
}
