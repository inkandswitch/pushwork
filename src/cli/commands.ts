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
  const spinner = ora("Starting initialization...").start();

  try {
    const resolvedPath = path.resolve(targetPath);

    // Step 1: Directory setup
    spinner.text = "Setting up directory structure...";
    await ensureDirectoryExists(resolvedPath);

    // Check if already initialized
    const syncToolDir = path.join(resolvedPath, ".sync-tool");
    if (await pathExists(syncToolDir)) {
      spinner.fail("Directory already initialized for sync");
      return;
    }

    // Step 2: Create sync directories
    spinner.text = "Creating .sync-tool directory...";
    await ensureDirectoryExists(syncToolDir);
    await ensureDirectoryExists(path.join(syncToolDir, "automerge"));

    console.log(chalk.gray("  ✓ Created sync directory structure"));

    // Step 3: Configuration setup
    spinner.text = "Setting up configuration...";
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

    console.log(chalk.gray("  ✓ Saved configuration"));
    console.log(chalk.gray(`  ✓ Remote repository: ${options.remote}`));
    console.log(chalk.gray("  ✓ Sync server: wss://sync3.automerge.org"));

    // Step 4: Initialize Automerge repo
    spinner.text = "Initializing Automerge repository...";
    const repo = createRepo(syncToolDir, config.sync_server);

    console.log(chalk.gray("  ✓ Created Automerge repository"));

    // Step 5: Scan existing files
    spinner.text = "Scanning existing files...";
    const syncEngine = new SyncEngine(repo, resolvedPath);

    // Get file count for progress
    const dirEntries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const fileCount = dirEntries.filter((dirent: any) =>
      dirent.isFile()
    ).length;

    if (fileCount > 0) {
      console.log(chalk.gray(`  ✓ Found ${fileCount} existing files`));
      spinner.text = `Creating initial snapshot with ${fileCount} files...`;
    } else {
      spinner.text = "Creating initial empty snapshot...";
    }

    // Step 6: Create initial snapshot
    const startTime = Date.now();
    await syncEngine.sync(false);
    const duration = Date.now() - startTime;

    console.log(chalk.gray(`  ✓ Initial sync completed in ${duration}ms`));

    spinner.succeed(`Initialized sync in ${chalk.green(resolvedPath)}`);

    console.log(`\n${chalk.bold("Setup Summary:")}:`);
    console.log(`  📁 Directory: ${chalk.blue(resolvedPath)}`);
    console.log(`  🌐 Remote repository: ${chalk.blue(options.remote)}`);
    console.log(`  🔗 Sync server: ${chalk.blue("wss://sync3.automerge.org")}`);
    console.log(`  📄 Files processed: ${chalk.yellow(fileCount)}`);
    console.log(
      `\n${chalk.green("Ready to sync!")} Run ${chalk.cyan(
        "sync-tool sync"
      )} to start syncing.`
    );
  } catch (error) {
    spinner.fail(`Failed to initialize: ${error}`);
    throw error;
  }
}

/**
 * Run bidirectional sync
 */
export async function sync(options: SyncOptions): Promise<void> {
  const spinner = ora("Starting sync operation...").start();

  try {
    const currentPath = process.cwd();

    // Step 1: Validation
    spinner.text = "Validating sync setup...";
    const syncToolDir = path.join(currentPath, ".sync-tool");
    if (!(await pathExists(syncToolDir))) {
      spinner.fail(
        'Directory not initialized for sync. Run "sync-tool init" first.'
      );
      return;
    }

    console.log(chalk.gray("  ✓ Sync directory found"));

    // Step 2: Load configuration
    spinner.text = "Loading configuration...";
    const syncConfigManager = new ConfigManager(currentPath);
    const syncConfig = await syncConfigManager.load();

    if (!syncConfig?.remote_repo) {
      spinner.fail("No remote repository configured");
      return;
    }

    console.log(chalk.gray(`  ✓ Remote repository: ${syncConfig.remote_repo}`));
    console.log(chalk.gray(`  ✓ Sync server: ${syncConfig.sync_server}`));

    // Step 3: Initialize Automerge repo
    spinner.text = "Connecting to Automerge repository...";
    const repo = createRepo(syncToolDir, syncConfig?.sync_server);
    const syncEngine = new SyncEngine(repo, currentPath);

    console.log(chalk.gray("  ✓ Connected to repository"));

    if (options.dryRun) {
      // Dry run mode - detailed preview
      spinner.text = "Analyzing changes (dry run)...";
      const startTime = Date.now();
      const preview = await syncEngine.previewChanges();
      const analysisTime = Date.now() - startTime;

      spinner.succeed("Change analysis completed");

      console.log(`\n${chalk.bold("📊 Change Analysis")} (${analysisTime}ms):`);
      console.log(chalk.gray(`  Directory: ${currentPath}`));
      console.log(chalk.gray(`  Analysis time: ${analysisTime}ms`));

      if (preview.changes.length === 0 && preview.moves.length === 0) {
        console.log(
          `\n${chalk.green("✨ No changes detected")} - everything is in sync!`
        );
        return;
      }

      console.log(`\n${chalk.bold("📋 Summary:")}`);
      console.log(`  ${preview.summary}`);

      if (preview.changes.length > 0) {
        const localChanges = preview.changes.filter(
          (c) =>
            c.changeType === "local_only" || c.changeType === "both_changed"
        ).length;
        const remoteChanges = preview.changes.filter(
          (c) =>
            c.changeType === "remote_only" || c.changeType === "both_changed"
        ).length;
        const conflicts = preview.changes.filter(
          (c) => c.changeType === "both_changed"
        ).length;

        console.log(
          `\n${chalk.bold("📁 File Changes:")} (${
            preview.changes.length
          } total)`
        );
        if (localChanges > 0) {
          console.log(`  ${chalk.green("📤")} Local changes: ${localChanges}`);
        }
        if (remoteChanges > 0) {
          console.log(`  ${chalk.blue("📥")} Remote changes: ${remoteChanges}`);
        }
        if (conflicts > 0) {
          console.log(`  ${chalk.yellow("⚠️")} Conflicts: ${conflicts}`);
        }

        console.log(`\n${chalk.bold("📄 Changed Files:")}`);
        for (const change of preview.changes.slice(0, 10)) {
          // Show first 10
          const typeIcon =
            change.changeType === "local_only"
              ? chalk.green("📤")
              : change.changeType === "remote_only"
              ? chalk.blue("📥")
              : change.changeType === "both_changed"
              ? chalk.yellow("⚠️")
              : chalk.gray("➖");
          console.log(`  ${typeIcon} ${change.path}`);
        }
        if (preview.changes.length > 10) {
          console.log(
            `  ${chalk.gray(
              `... and ${preview.changes.length - 10} more files`
            )}`
          );
        }
      }

      if (preview.moves.length > 0) {
        console.log(
          `\n${chalk.bold("🔄 Potential Moves:")} (${preview.moves.length})`
        );
        for (const move of preview.moves.slice(0, 5)) {
          // Show first 5
          const confidence =
            move.confidence === "auto"
              ? chalk.green("Auto")
              : move.confidence === "prompt"
              ? chalk.yellow("Prompt")
              : chalk.red("Low");
          console.log(`  🔄 ${move.fromPath} → ${move.toPath} (${confidence})`);
        }
        if (preview.moves.length > 5) {
          console.log(
            `  ${chalk.gray(`... and ${preview.moves.length - 5} more moves`)}`
          );
        }
      }

      console.log(
        `\n${chalk.cyan("ℹ️  Run without --dry-run to apply these changes")}`
      );
    } else {
      // Actual sync operation
      spinner.text = "Detecting changes...";
      const startTime = Date.now();

      const result = await syncEngine.sync(false);
      const totalTime = Date.now() - startTime;

      if (result.success) {
        spinner.succeed(`Sync completed in ${totalTime}ms`);

        console.log(`\n${chalk.bold("✅ Sync Results:")}`);
        console.log(`  📄 Files changed: ${chalk.yellow(result.filesChanged)}`);
        console.log(
          `  📁 Directories changed: ${chalk.yellow(result.directoriesChanged)}`
        );
        console.log(`  ⏱️  Total time: ${chalk.gray(totalTime + "ms")}`);

        if (result.warnings.length > 0) {
          console.log(
            `\n${chalk.yellow("⚠️  Warnings:")} (${result.warnings.length})`
          );
          for (const warning of result.warnings.slice(0, 5)) {
            console.log(`  ${chalk.yellow("⚠️")} ${warning}`);
          }
          if (result.warnings.length > 5) {
            console.log(
              `  ${chalk.gray(
                `... and ${result.warnings.length - 5} more warnings`
              )}`
            );
          }
        }

        if (result.filesChanged === 0 && result.directoriesChanged === 0) {
          console.log(`\n${chalk.green("✨ Everything already in sync!")}`);
        }
      } else {
        spinner.fail("Sync completed with errors");

        console.log(
          `\n${chalk.red("❌ Sync Errors:")} (${result.errors.length})`
        );
        for (const error of result.errors.slice(0, 5)) {
          console.log(
            `  ${chalk.red("❌")} ${error.path}: ${error.error.message}`
          );
        }
        if (result.errors.length > 5) {
          console.log(
            `  ${chalk.gray(`... and ${result.errors.length - 5} more errors`)}`
          );
        }

        if (result.filesChanged > 0 || result.directoriesChanged > 0) {
          console.log(`\n${chalk.yellow("⚠️  Partial sync completed:")}`);
          console.log(`  📄 Files changed: ${result.filesChanged}`);
          console.log(`  📁 Directories changed: ${result.directoriesChanged}`);
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
      console.log(chalk.red("❌ Directory not initialized for sync"));
      console.log(`   Run ${chalk.cyan("sync-tool init .")} to get started`);
      return;
    }

    const spinner = ora("Loading sync status...").start();

    // Initialize Automerge repo
    const statusConfigManager = new ConfigManager(currentPath);
    const statusConfig = await statusConfigManager.load();
    const repo = createRepo(syncToolDir, statusConfig?.sync_server);

    // Get status
    const syncEngine = new SyncEngine(repo, currentPath);
    const syncStatus = await syncEngine.getStatus();

    spinner.stop();

    console.log(chalk.bold("📊 Sync Status Report"));
    console.log(`${"=".repeat(50)}`);

    // Directory information
    console.log(`\n${chalk.bold("📁 Directory Information:")}`);
    console.log(`  📂 Path: ${chalk.blue(currentPath)}`);
    console.log(`  🔧 Config: ${path.join(currentPath, ".sync-tool")}`);

    // Sync timing
    if (syncStatus.lastSync) {
      const timeSince = Date.now() - syncStatus.lastSync.getTime();
      const timeAgo =
        timeSince < 60000
          ? `${Math.floor(timeSince / 1000)}s ago`
          : timeSince < 3600000
          ? `${Math.floor(timeSince / 60000)}m ago`
          : `${Math.floor(timeSince / 3600000)}h ago`;

      console.log(`\n${chalk.bold("⏱️  Sync Timing:")}`);
      console.log(
        `  🕐 Last sync: ${chalk.green(syncStatus.lastSync.toLocaleString())}`
      );
      console.log(`  ⏳ Time since: ${chalk.gray(timeAgo)}`);
    } else {
      console.log(`\n${chalk.bold("⏱️  Sync Timing:")}`);
      console.log(`  🕐 Last sync: ${chalk.yellow("Never synced")}`);
      console.log(
        `  💡 Run ${chalk.cyan("sync-tool sync")} to perform initial sync`
      );
    }

    // Change status
    console.log(`\n${chalk.bold("📝 Change Status:")}`);
    if (syncStatus.hasChanges) {
      console.log(
        `  📄 Pending changes: ${chalk.yellow(syncStatus.changeCount)}`
      );
      console.log(`  🔄 Status: ${chalk.yellow("Sync needed")}`);
      console.log(`  💡 Run ${chalk.cyan("sync-tool diff")} to see details`);
    } else {
      console.log(`  📄 Pending changes: ${chalk.green("None")}`);
      console.log(`  ✅ Status: ${chalk.green("Up to date")}`);
    }

    // Configuration
    console.log(`\n${chalk.bold("⚙️  Configuration:")}`);

    const statusConfigManager2 = new ConfigManager(currentPath);
    const statusConfig2 = await statusConfigManager2.load();

    if (statusConfig2?.remote_repo) {
      console.log(
        `  🌐 Remote repository: ${chalk.blue(statusConfig2.remote_repo)}`
      );
    } else {
      console.log(`  🌐 Remote repository: ${chalk.red("Not configured")}`);
    }

    if (statusConfig2?.sync_server) {
      console.log(`  🔗 Sync server: ${chalk.blue(statusConfig2.sync_server)}`);
    } else {
      console.log(`  🔗 Sync server: ${chalk.red("Not configured")}`);
    }

    console.log(
      `  ⚡ Auto sync: ${
        statusConfig2?.sync?.auto_sync
          ? chalk.green("Enabled")
          : chalk.gray("Disabled")
      }`
    );

    // Snapshot information
    if (syncStatus.snapshot) {
      const fileCount = syncStatus.snapshot.files.size;
      const dirCount = syncStatus.snapshot.directories.size;

      console.log(`\n${chalk.bold("📊 Repository Statistics:")}`);
      console.log(`  📄 Tracked files: ${chalk.yellow(fileCount)}`);
      console.log(`  📁 Tracked directories: ${chalk.yellow(dirCount)}`);
      console.log(
        `  🏷️  Snapshot timestamp: ${chalk.gray(
          new Date(syncStatus.snapshot.timestamp).toLocaleString()
        )}`
      );
    }

    // Quick actions
    console.log(`\n${chalk.bold("🚀 Quick Actions:")}`);
    if (syncStatus.hasChanges) {
      console.log(
        `  ${chalk.cyan("sync-tool diff")}     - View pending changes`
      );
      console.log(`  ${chalk.cyan("sync-tool sync")}     - Apply changes`);
    } else {
      console.log(
        `  ${chalk.cyan("sync-tool sync")}     - Check for remote changes`
      );
    }
    console.log(`  ${chalk.cyan("sync-tool log")}      - View sync history`);
  } catch (error) {
    console.error(chalk.red(`❌ Status check failed: ${error}`));
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
