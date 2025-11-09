import * as path from "path";
import * as fs from "fs/promises";
import { Repo, AutomergeUrl } from "@automerge/automerge-repo";
import chalk from "chalk";
import ora from "ora";
import * as diffLib from "diff";
import {
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
 * Shared context that commands can use
 */
export interface CommandContext {
  repo: Repo;
  syncEngine: SyncEngine;
  config: DirectoryConfig;
  workingDir: string;
}

/**
 * Validate that sync server options are used together
 */
function validateSyncServerOptions(
  syncServer?: string,
  syncServerStorageId?: string
): void {
  const hasSyncServer = !!syncServer;
  const hasSyncServerStorageId = !!syncServerStorageId;

  if (hasSyncServer && !hasSyncServerStorageId) {
    throw new Error(
      "--sync-server requires --sync-server-storage-id\nBoth arguments must be provided together."
    );
  }

  if (hasSyncServerStorageId && !hasSyncServer) {
    throw new Error(
      "--sync-server-storage-id requires --sync-server\nBoth arguments must be provided together."
    );
  }
}

/**
 * Shared pre-action that ensures repository and sync engine are properly initialized
 * This function always works, with or without network connectivity
 */
export async function setupCommandContext(
  workingDir: string = process.cwd(),
  customSyncServer?: string,
  customStorageId?: string,
  enableNetwork: boolean = true
): Promise<CommandContext> {
  const resolvedPath = path.resolve(workingDir);

  // Check if initialized
  const syncToolDir = path.join(resolvedPath, ".pushwork");
  if (!(await pathExists(syncToolDir))) {
    throw new Error(
      'Directory not initialized for sync. Run "pushwork init" first.'
    );
  }

  // Load configuration
  const configManager = new ConfigManager(resolvedPath);
  const config = await configManager.getMerged();

  // Create repo with configurable network setting
  const repo = await createRepo(resolvedPath, {
    enableNetwork,
    syncServer: customSyncServer,
    syncServerStorageId: customStorageId,
  });

  // Create sync engine with configurable network sync
  const syncEngine = new SyncEngine(
    repo,
    resolvedPath,
    config.defaults.exclude_patterns,
    enableNetwork,
    config.sync_server_storage_id
  );

  return {
    repo,
    syncEngine,
    config,
    workingDir: resolvedPath,
  };
}

/**
 * Safely shutdown a repository with proper error handling
 */
export async function safeRepoShutdown(
  repo: Repo,
  context?: string
): Promise<void> {
  try {
    await repo.shutdown();
  } catch (shutdownError) {
    // WebSocket errors during shutdown are common and non-critical
    // Silently ignore them - they don't affect data integrity
    const errorMessage =
      shutdownError instanceof Error
        ? shutdownError.message
        : String(shutdownError);

    // Ignore WebSocket-related errors entirely
    if (
      errorMessage.includes("WebSocket") ||
      errorMessage.includes("connection was established") ||
      errorMessage.includes("was closed")
    ) {
      // Silently ignore WebSocket shutdown errors
      return;
    }

    // Only warn about truly unexpected shutdown errors
    console.warn(
      `Warning: Repository shutdown failed${
        context ? ` (${context})` : ""
      }: ${shutdownError}`
    );
  }
}

/**
 * Common progress message helpers
 */
export const ProgressMessages = {
  // Setup messages
  directoryFound: () => console.log(chalk.gray("  ✓ Sync directory found")),
  configLoaded: () => console.log(chalk.gray("  ✓ Configuration loaded")),
  repoConnected: () => console.log(chalk.gray("  ✓ Connected to repository")),

  // Configuration display
  syncServer: (server: string) =>
    console.log(chalk.gray(`  ✓ Sync server: ${server}`)),
  storageId: (id: string) => console.log(chalk.gray(`  ✓ Storage ID: ${id}`)),
  rootUrl: (url: string) => console.log(chalk.gray(`  ✓ Root URL: ${url}`)),

  // Operation completion
  changesWritten: () =>
    console.log(chalk.gray("  ✓ All changes written to disk")),
  syncCompleted: (duration: number) =>
    console.log(chalk.gray(`  ✓ Initial sync completed in ${duration}ms`)),
  directoryStructureCreated: () =>
    console.log(chalk.gray("  ✓ Created sync directory structure")),
  configSaved: () => console.log(chalk.gray("  ✓ Saved configuration")),
  repoCreated: () =>
    console.log(chalk.gray("  ✓ Created Automerge repository")),
};

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
  // Validate sync server options
  validateSyncServerOptions(syncServer, syncServerStorageId);

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

    ProgressMessages.directoryStructureCreated();

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

    ProgressMessages.configSaved();
    ProgressMessages.syncServer(defaultSyncServer);
    ProgressMessages.storageId(defaultStorageId);

    // Step 4: Initialize Automerge repo and create root directory document
    spinner.text = "Creating root directory document...";
    const repo = await createRepo(resolvedPath, {
      enableNetwork: true,
      syncServer: syncServer,
      syncServerStorageId: syncServerStorageId,
    });

    // Create the root directory document
    const rootDoc: DirectoryDocument = {
      "@patchwork": { type: "folder" },
      docs: [],
    };
    const rootHandle = repo.create(rootDoc);

    ProgressMessages.repoCreated();
    ProgressMessages.rootUrl(rootHandle.url);

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

    ProgressMessages.syncCompleted(duration);

    // Step 8: Ensure all Automerge operations are flushed to disk
    spinner.text = "Flushing changes to disk...";
    await safeRepoShutdown(repo, "init");
    ProgressMessages.changesWritten();

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
    // Step 1: Setup shared context
    spinner.text = "Setting up sync context...";
    const { repo, syncEngine, config, workingDir } =
      await setupCommandContext();

    ProgressMessages.directoryFound();
    ProgressMessages.configLoaded();
    ProgressMessages.syncServer(
      config?.sync_server || "wss://sync3.automerge.org"
    );
    ProgressMessages.repoConnected();

    // Show root directory URL for context
    const syncStatus = await syncEngine.getStatus();
    if (syncStatus.snapshot?.rootDirectoryUrl) {
      ProgressMessages.rootUrl(syncStatus.snapshot.rootDirectoryUrl);
    }

    if (options.dryRun) {
      // Dry run mode - detailed preview
      spinner.text = "Analyzing changes (dry run)...";
      const startTime = Date.now();
      const preview = await syncEngine.previewChanges();
      const analysisTime = Date.now() - startTime;

      spinner.succeed("Change analysis completed");

      console.log(`\n${chalk.bold("📊 Change Analysis")} (${analysisTime}ms):`);
      console.log(chalk.gray(`  Directory: ${workingDir}`));
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
          const percentage = Math.round(move.similarity * 100);
          console.log(
            `  🔄 ${move.fromPath} → ${move.toPath} (${percentage}% similar)`
          );
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
        await safeRepoShutdown(repo, "sync");
        ProgressMessages.changesWritten();
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
        await safeRepoShutdown(repo, "sync-error");
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
    // Setup shared context with network disabled for diff check
    const { repo, syncEngine } = await setupCommandContext(
      targetPath,
      undefined,
      undefined,
      false
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
    await safeRepoShutdown(repo, "diff");
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
    const spinner = ora("Loading sync status...").start();

    // Setup shared context with network disabled for status check
    const { repo, syncEngine, workingDir, config } = await setupCommandContext(
      process.cwd(),
      undefined,
      undefined,
      false
    );
    const syncStatus = await syncEngine.getStatus();

    spinner.stop();

    console.log(chalk.bold("📊 Sync Status Report"));
    console.log(`${"=".repeat(50)}`);

    // Directory information
    console.log(`\n${chalk.bold("📁 Directory Information:")}`);
    console.log(`  📂 Path: ${chalk.blue(workingDir)}`);
    console.log(`  🔧 Config: ${path.join(workingDir, ".pushwork")}`);

    // Show root directory URL if available
    if (syncStatus.snapshot?.rootDirectoryUrl) {
      console.log(
        `  🔗 Root URL: ${chalk.cyan(syncStatus.snapshot.rootDirectoryUrl)}`
      );

      // Try to show lastSyncAt from root directory document
      try {
        const rootHandle = await repo.find<DirectoryDocument>(
          syncStatus.snapshot.rootDirectoryUrl
        );
        const rootDoc = await rootHandle.doc();
        if (rootDoc?.lastSyncAt) {
          const lastSyncDate = new Date(rootDoc.lastSyncAt);
          const timeSince = Date.now() - rootDoc.lastSyncAt;
          const timeAgo =
            timeSince < 60000
              ? `${Math.floor(timeSince / 1000)}s ago`
              : timeSince < 3600000
              ? `${Math.floor(timeSince / 60000)}m ago`
              : `${Math.floor(timeSince / 3600000)}h ago`;
          console.log(
            `  🕒 Root last touched: ${chalk.green(
              lastSyncDate.toLocaleString()
            )} (${chalk.gray(timeAgo)})`
          );
        } else {
          console.log(`  🕒 Root last touched: ${chalk.yellow("Never")}`);
        }
      } catch (error) {
        console.log(
          `  🕒 Root last touched: ${chalk.gray("Unable to determine")}`
        );
      }
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

    if (config?.sync_server) {
      console.log(`  🔗 Sync server: ${chalk.blue(config.sync_server)}`);
    } else {
      console.log(
        `  🔗 Sync server: ${chalk.blue("wss://sync3.automerge.org")} (default)`
      );
    }

    console.log(
      `  ⚡ Auto sync: ${
        config?.sync?.auto_sync
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
    await safeRepoShutdown(repo, "status");
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
    // Setup shared context with network disabled for log check
    const {
      repo: logRepo,
      syncEngine: logSyncEngine,
      workingDir,
    } = await setupCommandContext(targetPath, undefined, undefined, false);
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
    const snapshotPath = path.join(workingDir, ".pushwork", "snapshot.json");
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
    await safeRepoShutdown(logRepo, "log");
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
    // Setup shared context
    const { workingDir } = await setupCommandContext(targetPath);

    // TODO: Implement checkout functionality
    // This would involve:
    // 1. Finding the sync with the given ID
    // 2. Restoring file states from that sync
    // 3. Updating the snapshot

    console.log(chalk.yellow(`Checkout functionality not yet implemented`));
    console.log(`Would restore to sync: ${syncId}`);
    console.log(`Target path: ${workingDir}`);
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
  // Validate sync server options
  validateSyncServerOptions(options.syncServer, options.syncServerStorageId);

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

    ProgressMessages.directoryStructureCreated();

    // Step 3: Configuration setup
    spinner.text = "Setting up configuration...";
    const configManager = new ConfigManager(resolvedPath);
    const defaultSyncServer = options.syncServer || "wss://sync3.automerge.org";
    const defaultStorageId =
      options.syncServerStorageId || "3760df37-a4c6-4f66-9ecd-732039a9385d";
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

    ProgressMessages.configSaved();
    ProgressMessages.syncServer(defaultSyncServer);
    ProgressMessages.storageId(defaultStorageId);

    // Step 4: Initialize Automerge repo and connect to root directory
    spinner.text = "Connecting to root directory document...";
    const repo = await createRepo(resolvedPath, {
      enableNetwork: true,
      syncServer: options.syncServer,
      syncServerStorageId: options.syncServerStorageId,
    });

    ProgressMessages.repoCreated();
    ProgressMessages.rootUrl(rootUrl);

    // Step 5: Initialize sync engine and pull existing structure
    spinner.text = "Downloading directory structure...";
    const syncEngine = new SyncEngine(
      repo,
      resolvedPath,
      config.defaults.exclude_patterns,
      true, // Network sync enabled for clone
      defaultStorageId
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
    await safeRepoShutdown(repo, "clone");
    ProgressMessages.changesWritten();

    spinner.succeed(`Cloned sync directory to ${chalk.green(resolvedPath)}`);

    console.log(`\n${chalk.bold("📂 Directory Cloned!")}`);
    console.log(`  📁 Directory: ${chalk.blue(resolvedPath)}`);
    console.log(`  🔗 Root URL: ${chalk.cyan(rootUrl)}`);
    console.log(`  🔗 Sync server: ${chalk.blue(defaultSyncServer)}`);
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

/**
 * Get the root URL for the current pushwork repository
 */
export async function url(targetPath = "."): Promise<void> {
  try {
    const resolvedPath = path.resolve(targetPath);

    // Check if initialized
    const syncToolDir = path.join(resolvedPath, ".pushwork");
    if (!(await pathExists(syncToolDir))) {
      console.error(chalk.red("Directory not initialized for sync"));
      console.error(`Run ${chalk.cyan("pushwork init .")} to get started`);
      process.exit(1);
    }

    // Load the snapshot directly to get the URL without all the verbose output
    const snapshotPath = path.join(syncToolDir, "snapshot.json");
    if (!(await pathExists(snapshotPath))) {
      console.error(chalk.red("No snapshot found"));
      console.error(
        chalk.gray("The repository may not be properly initialized")
      );
      process.exit(1);
    }

    const snapshotData = await fs.readFile(snapshotPath, "utf-8");
    const snapshot = JSON.parse(snapshotData);

    if (snapshot.rootDirectoryUrl) {
      // Output just the URL for easy use in scripts
      console.log(snapshot.rootDirectoryUrl);
    } else {
      console.error(chalk.red("No root URL found in snapshot"));
      console.error(
        chalk.gray("The repository may not be properly initialized")
      );
      process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red(`Failed to get URL: ${error}`));
    process.exit(1);
  }
}

export async function commit(
  targetPath: string,
  dryRun: boolean = false
): Promise<void> {
  const spinner = ora("Starting commit operation...").start();
  let repo: Repo | undefined;

  try {
    // Setup shared context with network disabled for local-only commit
    spinner.text = "Setting up commit context...";
    const context = await setupCommandContext(
      targetPath,
      undefined,
      undefined,
      false
    );
    repo = context.repo;
    const syncEngine = context.syncEngine;
    spinner.succeed("Connected to repository");

    // Run local commit only
    spinner.text = "Committing local changes...";
    const startTime = Date.now();
    const result = await syncEngine.commitLocal(dryRun);
    const duration = Date.now() - startTime;

    if (repo) {
      await safeRepoShutdown(repo, "commit");
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
      await safeRepoShutdown(repo, "commit-error");
    }
    spinner.fail(`Commit failed: ${error}`);
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

/**
 * Debug command to inspect internal document state
 */
export async function debug(
  targetPath = ".",
  options: { verbose?: boolean } = {}
): Promise<void> {
  try {
    const spinner = ora("Loading debug information...").start();

    // Setup shared context with network disabled for debug check
    const { repo, syncEngine, workingDir } = await setupCommandContext(
      targetPath,
      undefined,
      undefined,
      false
    );
    const debugStatus = await syncEngine.getStatus();

    spinner.stop();

    console.log(chalk.bold("🔍 Debug Information"));
    console.log(`${"=".repeat(50)}`);

    // Directory information
    console.log(`\n${chalk.bold("📁 Directory Information:")}`);
    console.log(`  📂 Path: ${chalk.blue(workingDir)}`);
    console.log(`  🔧 Config: ${path.join(workingDir, ".pushwork")}`);

    if (debugStatus.snapshot?.rootDirectoryUrl) {
      console.log(`\n${chalk.bold("🗂️  Root Directory Document:")}`);
      console.log(
        `  🔗 URL: ${chalk.cyan(debugStatus.snapshot.rootDirectoryUrl)}`
      );

      try {
        const rootHandle = await repo.find<DirectoryDocument>(
          debugStatus.snapshot.rootDirectoryUrl
        );
        const rootDoc = await rootHandle.doc();

        if (rootDoc) {
          console.log(`  📊 Document Structure:`);
          console.log(`    📄 Entries: ${rootDoc.docs.length}`);
          console.log(`    🏷️  Type: ${rootDoc["@patchwork"].type}`);

          if (rootDoc.lastSyncAt) {
            const lastSyncDate = new Date(rootDoc.lastSyncAt);
            console.log(
              `    🕒 Last Sync At: ${chalk.green(lastSyncDate.toISOString())}`
            );
            console.log(
              `    🕒 Last Sync Timestamp: ${chalk.gray(rootDoc.lastSyncAt)}`
            );
          } else {
            console.log(`    🕒 Last Sync At: ${chalk.yellow("Never set")}`);
          }

          if (options.verbose) {
            console.log(`\n  📋 Full Document Content:`);
            console.log(JSON.stringify(rootDoc, null, 2));

            console.log(`\n  🏷️  Document Heads:`);
            console.log(JSON.stringify(rootHandle.heads(), null, 2));
          }

          console.log(`\n  📁 Directory Entries:`);
          rootDoc.docs.forEach((entry: any, index: number) => {
            console.log(
              `    ${index + 1}. ${entry.name} (${entry.type}) -> ${entry.url}`
            );
          });
        } else {
          console.log(`  ❌ Unable to load root document`);
        }
      } catch (error) {
        console.log(`  ❌ Error loading root document: ${error}`);
      }
    } else {
      console.log(`\n${chalk.bold("🗂️  Root Directory Document:")}`);
      console.log(`  ❌ No root directory URL set`);
    }

    // Snapshot information
    if (debugStatus.snapshot) {
      console.log(`\n${chalk.bold("📸 Snapshot Information:")}`);
      console.log(`  📄 Tracked files: ${debugStatus.snapshot.files.size}`);
      console.log(
        `  📁 Tracked directories: ${debugStatus.snapshot.directories.size}`
      );
      console.log(
        `  🏷️  Timestamp: ${new Date(
          debugStatus.snapshot.timestamp
        ).toISOString()}`
      );
      console.log(`  📂 Root path: ${debugStatus.snapshot.rootPath}`);

      if (options.verbose) {
        console.log(`\n  📋 All Tracked Files:`);
        debugStatus.snapshot.files.forEach((entry, path) => {
          console.log(`    ${path} -> ${entry.url}`);
        });

        console.log(`\n  📋 All Tracked Directories:`);
        debugStatus.snapshot.directories.forEach((entry, path) => {
          console.log(`    ${path} -> ${entry.url}`);
        });
      }
    }

    // Cleanup repo resources
    await safeRepoShutdown(repo, "debug");
  } catch (error) {
    console.error(chalk.red(`Debug failed: ${error}`));
    throw error;
  }
}

// TODO: Add push and pull commands later
