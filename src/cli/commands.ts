import * as path from "path";
import * as fs from "fs/promises";
import { Repo, StorageId, AutomergeUrl } from "@automerge/automerge-repo";
import chalk from "chalk";
import ora from "ora";
import * as diffLib from "diff";
import {
  InitOptions,
  CloneOptions,
  SyncOptions,
  DiffOptions,
  LogOptions,
  CheckoutOptions,
  DirectoryConfig,
  DirectoryDocument,
} from "../types";
import { SyncEngine } from "../core";
import { DetectedChange } from "../core/change-detection";
import { pathExists, ensureDirectoryExists } from "../utils";
import { ConfigManager } from "../config";
import { createRepo } from "../utils/repo-factory";

/**
 * Show actual content diff for a changed file
 */
async function showContentDiff(change: DetectedChange): Promise<void> {
  try {
    // Get old content (from snapshot/remote)
    const oldContent = change.remoteContent || "";

    // Get new content (current local)
    const newContent = change.localContent || "";

    // Convert binary content to string representation if needed
    const oldText =
      typeof oldContent === "string"
        ? oldContent
        : `<binary content: ${oldContent.length} bytes>`;
    const newText =
      typeof newContent === "string"
        ? newContent
        : `<binary content: ${newContent.length} bytes>`;

    // Generate unified diff
    const diffResult = diffLib.createPatch(
      change.path,
      oldText,
      newText,
      "previous",
      "current"
    );

    // Skip the header lines and process the diff
    const lines = diffResult.split("\n").slice(4); // Skip index, ===, ---, +++ lines

    if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
      console.log(chalk.gray("  (content identical)"));
      return;
    }

    for (const line of lines) {
      if (line.startsWith("@@")) {
        // Hunk header
        console.log(chalk.cyan(line));
      } else if (line.startsWith("+")) {
        // Added line
        console.log(chalk.green(line));
      } else if (line.startsWith("-")) {
        // Removed line
        console.log(chalk.red(line));
      } else if (line.startsWith(" ")) {
        // Context line
        console.log(chalk.gray(line));
      } else if (line === "") {
        // Empty line
        console.log("");
      }
    }
  } catch (error) {
    console.log(chalk.gray(`  (diff error: ${error})`));
  }
}

/**
 * Initialize sync in a directory
 */
export async function init(
  targetPath: string,
  syncServer?: string,
  syncServerStorageId?: string
): Promise<void> {
  const spinner = ora("Starting initialization...").start();

  try {
    const resolvedPath = path.resolve(targetPath);

    // Step 1: Directory setup
    spinner.text = "Setting up directory structure...";
    await ensureDirectoryExists(resolvedPath);

    // Check if already initialized
    const syncToolDir = path.join(resolvedPath, ".pushwork");
    if (await pathExists(syncToolDir)) {
      spinner.fail("Directory already initialized for sync");
      return;
    }

    // Step 2: Create sync directories
    spinner.text = "Creating .pushwork directory...";
    await ensureDirectoryExists(syncToolDir);
    await ensureDirectoryExists(path.join(syncToolDir, "automerge"));

    console.log(chalk.gray("  ✓ Created sync directory structure"));

    // Step 3: Configuration setup
    spinner.text = "Setting up configuration...";
    const configManager = new ConfigManager(resolvedPath);
    const defaultSyncServer = syncServer || "wss://sync3.automerge.org";
    const defaultStorageId =
      syncServerStorageId || "3760df37-a4c6-4f66-9ecd-732039a9385d";
    const config: DirectoryConfig = {
      sync_server: defaultSyncServer,
      sync_server_storage_id: defaultStorageId,
      sync_enabled: true,
      defaults: {
        exclude_patterns: [".git", "node_modules", "*.tmp", ".pushwork"],
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
    console.log(chalk.gray(`  ✓ Sync server: ${defaultSyncServer}`));
    console.log(chalk.gray(`  ✓ Storage ID: ${defaultStorageId}`));

    // Step 4: Initialize Automerge repo and create root directory document
    spinner.text = "Creating root directory document...";
    const repo = await createRepo(resolvedPath, {
      enableNetwork: true,
      syncServer: syncServer,
      syncServerStorageId: syncServerStorageId,
    });

    // Create the root directory document
    const rootDoc: DirectoryDocument = {
      docs: [],
    };
    const rootHandle = repo.create(rootDoc);

    console.log(chalk.gray("  ✓ Created Automerge repository"));
    console.log(chalk.gray(`  ✓ Root directory URL: ${rootHandle.url}`));

    // Step 5: Scan existing files
    spinner.text = "Scanning existing files...";
    const syncEngine = new SyncEngine(
      repo,
      resolvedPath,
      config.defaults.exclude_patterns,
      true, // Network sync enabled for init
      config.sync_server_storage_id
    );

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

    // Step 6: Set the root directory URL before creating initial snapshot
    await syncEngine.setRootDirectoryUrl(rootHandle.url);

    // Step 7: Create initial snapshot
    spinner.text = "Creating initial snapshot...";
    const startTime = Date.now();
    await syncEngine.sync(false);
    const duration = Date.now() - startTime;

    console.log(chalk.gray(`  ✓ Initial sync completed in ${duration}ms`));

    // Step 8: Ensure all Automerge operations are flushed to disk
    spinner.text = "Flushing changes to disk...";
    try {
      await repo.shutdown();
      console.log(chalk.gray("  ✓ All changes written to disk"));
    } catch (shutdownError) {
      console.log(chalk.gray("  ✓ All changes written to disk"));
    }

    spinner.succeed(`Initialized sync in ${chalk.green(resolvedPath)}`);

    console.log(`\n${chalk.bold("🎉 Sync Directory Created!")}`);
    console.log(`  📁 Directory: ${chalk.blue(resolvedPath)}`);
    console.log(`  🔗 Sync server: ${chalk.blue(defaultSyncServer)}`);
    console.log(
      `\n${chalk.green("Initialization complete!")} Run ${chalk.cyan(
        "pushwork sync"
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
    const syncToolDir = path.join(currentPath, ".pushwork");
    if (!(await pathExists(syncToolDir))) {
      spinner.fail(
        'Directory not initialized for sync. Run "pushwork init" first.'
      );
      return;
    }

    console.log(chalk.gray("  ✓ Sync directory found"));

    // Step 2: Load configuration
    spinner.text = "Loading configuration...";
    const syncConfigManager = new ConfigManager(currentPath);
    const syncConfig = await syncConfigManager.getMerged();

    console.log(chalk.gray(`  ✓ Configuration loaded`));
    console.log(
      chalk.gray(
        `  ✓ Sync server: ${
          syncConfig?.sync_server || "wss://sync3.automerge.org"
        }`
      )
    );

    // Step 3: Initialize Automerge repo
    spinner.text = "Connecting to Automerge repository...";
    const repo = await createRepo(currentPath, {
      enableNetwork: !options.localOnly,
    });
    const syncEngine = new SyncEngine(
      repo,
      currentPath,
      syncConfig.defaults.exclude_patterns,
      !options.localOnly // Pass network sync setting
    );

    console.log(chalk.gray("  ✓ Connected to repository"));

    // Show root directory URL for context
    const syncStatus = await syncEngine.getStatus();
    if (syncStatus.snapshot?.rootDirectoryUrl) {
      console.log(
        chalk.gray(`  ✓ Root URL: ${syncStatus.snapshot.rootDirectoryUrl}`)
      );
    }

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

        // Ensure all changes are flushed to disk
        spinner.text = "Flushing changes to disk...";
        try {
          await repo.shutdown();
        } catch (shutdownError) {
          // Ignore shutdown errors - they don't affect sync success
          console.log(chalk.gray("  ✓ Changes written to disk"));
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

        // Still try to flush any partial changes
        try {
          await repo.shutdown();
        } catch (shutdownError) {
          // Ignore shutdown errors
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
    const syncToolDir = path.join(resolvedPath, ".pushwork");
    if (!(await pathExists(syncToolDir))) {
      console.log(chalk.red("Directory not initialized for sync"));
      return;
    }

    // Load configuration
    const diffConfigManager = new ConfigManager(resolvedPath);
    const diffConfig = await diffConfigManager.getMerged();

    // Initialize Automerge repo
    const repo = await createRepo(resolvedPath, {
      enableNetwork: !options.localOnly,
    });

    // Get changes
    const syncEngine = new SyncEngine(
      repo,
      resolvedPath,
      diffConfig.defaults.exclude_patterns,
      !options.localOnly // Pass network sync setting
    );
    const preview = await syncEngine.previewChanges();

    if (options.nameOnly) {
      // Show only file names
      for (const change of preview.changes) {
        console.log(change.path);
      }
      return;
    }

    // Show root directory URL for context
    const diffStatus = await syncEngine.getStatus();
    if (diffStatus.snapshot?.rootDirectoryUrl) {
      console.log(
        chalk.gray(`Root URL: ${diffStatus.snapshot.rootDirectoryUrl}`)
      );
      console.log("");
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

      console.log(`\n${typeLabel} ${change.path}`);

      if (options.tool) {
        console.log(`  Use "${options.tool}" to view detailed diff`);
      } else {
        // Show actual diff content
        await showContentDiff(change);
      }
    }

    // Cleanup repo resources
    try {
      await repo.shutdown();
    } catch (shutdownError) {
      // Ignore shutdown errors
    }
  } catch (error) {
    console.error(chalk.red(`Diff failed: ${error}`));
    throw error;
  }
}

/**
 * Show sync status
 */
export async function status(localOnly: boolean = false): Promise<void> {
  try {
    const currentPath = process.cwd();

    // Check if initialized
    const syncToolDir = path.join(currentPath, ".pushwork");
    if (!(await pathExists(syncToolDir))) {
      console.log(chalk.red("❌ Directory not initialized for sync"));
      console.log(`   Run ${chalk.cyan("pushwork init .")} to get started`);
      return;
    }

    const spinner = ora("Loading sync status...").start();

    // Initialize Automerge repo
    const statusConfigManager = new ConfigManager(currentPath);
    const statusConfig = await statusConfigManager.getMerged();
    const repo = await createRepo(currentPath, {
      enableNetwork: !localOnly,
    });

    // Get status
    const syncEngine = new SyncEngine(
      repo,
      currentPath,
      statusConfig.defaults.exclude_patterns,
      !localOnly // Pass network sync setting
    );
    const syncStatus = await syncEngine.getStatus();

    spinner.stop();

    console.log(chalk.bold("📊 Sync Status Report"));
    console.log(`${"=".repeat(50)}`);

    // Directory information
    console.log(`\n${chalk.bold("📁 Directory Information:")}`);
    console.log(`  📂 Path: ${chalk.blue(currentPath)}`);
    console.log(`  🔧 Config: ${path.join(currentPath, ".pushwork")}`);

    // Show root directory URL if available
    if (syncStatus.snapshot?.rootDirectoryUrl) {
      console.log(
        `  🔗 Root URL: ${chalk.cyan(syncStatus.snapshot.rootDirectoryUrl)}`
      );
    } else {
      console.log(`  🔗 Root URL: ${chalk.yellow("Not set")}`);
    }

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
        `  💡 Run ${chalk.cyan("pushwork sync")} to perform initial sync`
      );
    }

    // Change status
    console.log(`\n${chalk.bold("📝 Change Status:")}`);
    if (syncStatus.hasChanges) {
      console.log(
        `  📄 Pending changes: ${chalk.yellow(syncStatus.changeCount)}`
      );
      console.log(`  🔄 Status: ${chalk.yellow("Sync needed")}`);
      console.log(`  💡 Run ${chalk.cyan("pushwork diff")} to see details`);
    } else {
      console.log(`  📄 Pending changes: ${chalk.green("None")}`);
      console.log(`  ✅ Status: ${chalk.green("Up to date")}`);
    }

    // Configuration
    console.log(`\n${chalk.bold("⚙️  Configuration:")}`);

    const statusConfigManager2 = new ConfigManager(currentPath);
    const statusConfig2 = await statusConfigManager2.load();

    if (statusConfig2?.sync_server) {
      console.log(`  🔗 Sync server: ${chalk.blue(statusConfig2.sync_server)}`);
    } else {
      console.log(
        `  🔗 Sync server: ${chalk.blue("wss://sync3.automerge.org")} (default)`
      );
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
        `  ${chalk.cyan("pushwork diff")}     - View pending changes`
      );
      console.log(`  ${chalk.cyan("pushwork sync")}     - Apply changes`);
    } else {
      console.log(
        `  ${chalk.cyan("pushwork sync")}     - Check for remote changes`
      );
    }
    console.log(`  ${chalk.cyan("pushwork log")}      - View sync history`);

    // Cleanup repo resources
    try {
      await repo.shutdown();
    } catch (shutdownError) {
      // Ignore shutdown errors
    }
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
    const syncToolDir = path.join(resolvedPath, ".pushwork");
    if (!(await pathExists(syncToolDir))) {
      console.log(chalk.red("Directory not initialized for sync"));
      return;
    }

    // Load configuration and show root URL
    const logConfigManager = new ConfigManager(resolvedPath);
    const logConfig = await logConfigManager.getMerged();
    const logRepo = await createRepo(resolvedPath, {
      enableNetwork: true,
    });
    const logSyncEngine = new SyncEngine(
      logRepo,
      resolvedPath,
      logConfig.defaults.exclude_patterns,
      true // Network sync enabled for log
    );
    const logStatus = await logSyncEngine.getStatus();

    if (logStatus.snapshot?.rootDirectoryUrl) {
      console.log(
        chalk.gray(`Root URL: ${logStatus.snapshot.rootDirectoryUrl}`)
      );
      console.log("");
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

    // Cleanup repo resources
    await logRepo.shutdown();
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
    const syncToolDir = path.join(resolvedPath, ".pushwork");
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

/**
 * Clone an existing synced directory from an AutomergeUrl
 */
export async function clone(
  rootUrl: string,
  targetPath: string,
  options: CloneOptions
): Promise<void> {
  const spinner = ora("Starting clone operation...").start();

  try {
    const resolvedPath = path.resolve(targetPath);

    // Step 1: Directory setup
    spinner.text = "Setting up target directory...";

    // Check if directory exists and handle --force
    if (await pathExists(resolvedPath)) {
      const files = await fs.readdir(resolvedPath);
      if (files.length > 0 && !options.force) {
        spinner.fail(
          "Target directory is not empty. Use --force to overwrite."
        );
        return;
      }
    } else {
      await ensureDirectoryExists(resolvedPath);
    }

    // Check if already initialized
    const syncToolDir = path.join(resolvedPath, ".pushwork");
    if (await pathExists(syncToolDir)) {
      if (!options.force) {
        spinner.fail(
          "Directory already initialized for sync. Use --force to overwrite."
        );
        return;
      }
      // Clean up existing sync directory
      await fs.rm(syncToolDir, { recursive: true, force: true });
    }

    console.log(chalk.gray("  ✓ Target directory prepared"));

    // Step 2: Create sync directories
    spinner.text = "Creating .pushwork directory...";
    await ensureDirectoryExists(syncToolDir);
    await ensureDirectoryExists(path.join(syncToolDir, "automerge"));

    console.log(chalk.gray("  ✓ Created sync directory structure"));

    // Step 3: Configuration setup
    spinner.text = "Setting up configuration...";
    const configManager = new ConfigManager(resolvedPath);
    const config: DirectoryConfig = {
      sync_server: "wss://sync3.automerge.org",
      sync_enabled: true,
      defaults: {
        exclude_patterns: [".git", "node_modules", "*.tmp", ".pushwork"],
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
    console.log(chalk.gray("  ✓ Sync server: wss://sync3.automerge.org"));

    // Step 4: Initialize Automerge repo and connect to root directory
    spinner.text = "Connecting to root directory document...";
    const repo = await createRepo(resolvedPath, {
      enableNetwork: true,
    });

    console.log(chalk.gray("  ✓ Created Automerge repository"));
    console.log(chalk.gray(`  ✓ Root directory URL: ${rootUrl}`));

    // Step 5: Initialize sync engine and pull existing structure
    spinner.text = "Downloading directory structure...";
    const syncEngine = new SyncEngine(
      repo,
      resolvedPath,
      config.defaults.exclude_patterns,
      true // Network sync enabled for clone
    );

    // Set the root directory URL to connect to the cloned repository
    await syncEngine.setRootDirectoryUrl(rootUrl as AutomergeUrl);

    // Sync to pull the existing directory structure and files
    const startTime = Date.now();
    await syncEngine.sync(false);
    const duration = Date.now() - startTime;

    console.log(chalk.gray(`  ✓ Directory sync completed in ${duration}ms`));

    // Ensure all changes are flushed to disk
    spinner.text = "Flushing changes to disk...";
    try {
      await repo.shutdown();
      console.log(chalk.gray("  ✓ All changes written to disk"));
    } catch (shutdownError) {
      console.log(chalk.gray("  ✓ All changes written to disk"));
    }

    spinner.succeed(`Cloned sync directory to ${chalk.green(resolvedPath)}`);

    console.log(`\n${chalk.bold("📂 Directory Cloned!")}`);
    console.log(`  📁 Directory: ${chalk.blue(resolvedPath)}`);
    console.log(`  🔗 Root URL: ${chalk.cyan(rootUrl)}`);
    console.log(`  🔗 Sync server: ${chalk.blue("wss://sync3.automerge.org")}`);
    console.log(
      `\n${chalk.green("Clone complete!")} Run ${chalk.cyan(
        "pushwork sync"
      )} to stay in sync.`
    );
  } catch (error) {
    spinner.fail(`Failed to clone: ${error}`);
    throw error;
  }
}

export async function commit(
  targetPath: string,
  dryRun: boolean = false
): Promise<void> {
  const spinner = ora("Starting commit operation...").start();
  let repo: Repo | undefined;

  try {
    // Load configuration
    spinner.text = "Loading configuration...";
    const configManager = new ConfigManager(targetPath);
    const config = await configManager.load();
    spinner.succeed("Configuration loaded");

    // Create repository (local only - no network)
    spinner.text = "Connecting to local repository...";
    repo = await createRepo(targetPath, {
      enableNetwork: false,
    });
    spinner.succeed("Connected to local repository");

    // Create sync engine
    const syncEngine = new SyncEngine(repo, targetPath, [], false); // No network

    // Run local commit only
    spinner.text = "Committing local changes...";
    const startTime = Date.now();
    const result = await syncEngine.commitLocal(dryRun);
    const duration = Date.now() - startTime;

    if (repo) {
      try {
        await repo.shutdown();
      } catch (shutdownError) {
        console.warn(`Warning: Repository shutdown failed: ${shutdownError}`);
      }
    }
    spinner.succeed(`Commit completed in ${duration}ms`);

    // Display results
    console.log(chalk.green("\n✅ Commit Results:"));
    console.log(`  📄 Files committed: ${result.filesChanged}`);
    console.log(`  📁 Directories committed: ${result.directoriesChanged}`);
    console.log(`  ⏱️  Total time: ${duration}ms`);

    if (result.warnings.length > 0) {
      console.log(chalk.yellow("\n⚠️  Warnings:"));
      result.warnings.forEach((warning: string) =>
        console.log(chalk.yellow(`  • ${warning}`))
      );
    }

    if (result.errors.length > 0) {
      console.log(chalk.red("\n❌ Errors:"));
      result.errors.forEach((error) =>
        console.log(
          chalk.red(
            `  • ${error.operation} at ${error.path}: ${error.error.message}`
          )
        )
      );
      process.exit(1);
    }

    console.log(
      chalk.gray("\n💡 Run 'pushwork push' to upload to sync server")
    );
  } catch (error) {
    if (repo) {
      try {
        await repo.shutdown();
      } catch (shutdownError) {
        console.warn(`Warning: Repository shutdown failed: ${shutdownError}`);
      }
    }
    spinner.fail(`Commit failed: ${error}`);
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

// TODO: Add push and pull commands later
