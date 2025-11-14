import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { Repo, AutomergeUrl } from "@automerge/automerge-repo";
import * as diffLib from "diff";
import { spawn } from "child_process";
import {
  CloneOptions,
  SyncOptions,
  DiffOptions,
  LogOptions,
  CheckoutOptions,
  InitOptions,
  ConfigOptions,
  StatusOptions,
  WatchOptions,
  DirectoryConfig,
  DirectoryDocument,
  CommandOptions,
} from "./types";
import { SyncEngine } from "./core";
import { pathExists, ensureDirectoryExists, formatRelativePath } from "./utils";
import { ConfigManager } from "./core/config";
import { createRepo } from "./utils/repo-factory";
import { out } from "./utils/output";
import chalk from "chalk";

/**
 * Shared context that commands can use
 */
interface CommandContext {
  repo: Repo;
  syncEngine: SyncEngine;
  config: DirectoryConfig;
  workingDir: string;
}

/**
 * Initialize repository directory structure and configuration
 * Shared logic for init and clone commands
 */
async function initializeRepository(
  resolvedPath: string,
  overrides: Partial<DirectoryConfig>
): Promise<{ config: DirectoryConfig; repo: Repo; syncEngine: SyncEngine }> {
  // Create .pushwork directory structure
  const syncToolDir = path.join(resolvedPath, ".pushwork");
  await ensureDirectoryExists(syncToolDir);
  await ensureDirectoryExists(path.join(syncToolDir, "automerge"));

  // Create configuration with overrides
  const configManager = new ConfigManager(resolvedPath);
  const config = await configManager.initializeWithOverrides(overrides);

  // Create repository and sync engine
  const repo = await createRepo(resolvedPath, config);
  const syncEngine = new SyncEngine(repo, resolvedPath, config);

  return { config, repo, syncEngine };
}

/**
 * Shared pre-action that ensures repository and sync engine are properly initialized
 * This function always works, with or without network connectivity
 */
async function setupCommandContext(
  workingDir: string = process.cwd(),
  syncEnabled?: boolean
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
  let config = await configManager.getMerged();

  // Override sync_enabled if explicitly specified (e.g., for local-only operations)
  if (syncEnabled !== undefined) {
    config = { ...config, sync_enabled: syncEnabled };
  }

  // Create repo with config
  const repo = await createRepo(resolvedPath, config);

  // Create sync engine
  const syncEngine = new SyncEngine(repo, resolvedPath, config);

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
async function safeRepoShutdown(repo: Repo, context?: string): Promise<void> {
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
 * Initialize sync in a directory
 */
export async function init(
  targetPath: string,
  options: InitOptions = {}
): Promise<void> {
  const resolvedPath = path.resolve(targetPath);

  out.task(`Initializing`);

  await ensureDirectoryExists(resolvedPath);

  // Check if already initialized
  const syncToolDir = path.join(resolvedPath, ".pushwork");
  if (await pathExists(syncToolDir)) {
    out.error("Directory already initialized for sync");
    out.exit(1);
  }

  // Initialize repository with optional CLI overrides
  out.update("Setting up repository");
  const { config, repo, syncEngine } = await initializeRepository(
    resolvedPath,
    {
      sync_server: options.syncServer,
      sync_server_storage_id: options.syncServerStorageId,
    }
  );

  // Create new root directory document
  out.update("Creating root directory");
  const rootDoc: DirectoryDocument = {
    "@patchwork": { type: "folder" },
    docs: [],
  };
  const rootHandle = repo.create(rootDoc);

  // Scan and sync existing files
  out.update("Scanning existing files");
  await syncEngine.setRootDirectoryUrl(rootHandle.url);
  const result = await syncEngine.sync();

  out.update("Writing to disk");
  await safeRepoShutdown(repo, "init");

  out.done("Initialized");

  out.obj({
    Sync: config.sync_server,
    Files: result.filesChanged > 0 ? `${result.filesChanged} added` : undefined,
  });
  out.successBlock("INITIALIZED", rootHandle.url);

  process.exit();
}

/**
 * Run bidirectional sync
 */
export async function sync(
  targetPath = ".",
  options: SyncOptions
): Promise<void> {
  out.task("Syncing");

  const { repo, syncEngine } = await setupCommandContext(targetPath);

  if (options.dryRun) {
    out.update("Analyzing changes");
    const preview = await syncEngine.previewChanges();

    if (preview.changes.length === 0 && preview.moves.length === 0) {
      out.done("Already synced");
      return;
    }

    out.done();
    out.infoBlock("CHANGES");
    out.obj({
      Changes: preview.changes.length.toString(),
      Moves:
        preview.moves.length > 0 ? preview.moves.length.toString() : undefined,
    });

    out.log("");
    out.log("Files:");
    for (const change of preview.changes.slice(0, 10)) {
      const prefix =
        change.changeType === "local_only"
          ? "[local]  "
          : change.changeType === "remote_only"
          ? "[remote] "
          : "[conflict]";
      out.log(`  ${prefix} ${change.path}`);
    }
    if (preview.changes.length > 10) {
      out.log(`  ... and ${preview.changes.length - 10} more`);
    }

    if (preview.moves.length > 0) {
      out.log("");
      out.log("Moves:");
      for (const move of preview.moves.slice(0, 5)) {
        out.log(`  ${move.fromPath} → ${move.toPath}`);
      }
      if (preview.moves.length > 5) {
        out.log(`  ... and ${preview.moves.length - 5} more`);
      }
    }

    out.log("");
    out.log("Run without --dry-run to apply these changes");
  } else {
    const result = await syncEngine.sync();

    out.taskLine("Writing to disk");
    await safeRepoShutdown(repo, "sync");

    if (result.success) {
      out.done("Synced");
      if (result.filesChanged === 0 && result.directoriesChanged === 0) {
      } else {
        out.successBlock(
          "SYNCED",
          `${result.filesChanged} ${plural("file", result.filesChanged)}`
        );
      }

      if (result.warnings.length > 0) {
        out.log("");
        out.warnBlock("WARNINGS", `${result.warnings.length} warnings`);
        for (const warning of result.warnings.slice(0, 5)) {
          out.log(`  ${warning}`);
        }
        if (result.warnings.length > 5) {
          out.log(`  ... and ${result.warnings.length - 5} more`);
        }
      }
    } else {
      out.done("partial", false);
      out.warnBlock(
        "PARTIAL",
        `${result.filesChanged} updated, ${result.errors.length} errors`
      );
      out.obj({
        Files: result.filesChanged,
        Errors: result.errors.length,
      });

      result.errors
        .slice(0, 5)
        .forEach((error) => out.error(`${error.path}: ${error.error.message}`));
      if (result.errors.length > 5) {
        out.warn(`... and ${result.errors.length - 5} more errors`);
      }
    }
  }

  process.exit();
}

/**
 * Show differences between local and remote
 */
export async function diff(
  targetPath = ".",
  options: DiffOptions
): Promise<void> {
  out.task("Analyzing changes");

  const { repo, syncEngine } = await setupCommandContext(targetPath, false);
  const preview = await syncEngine.previewChanges();

  out.done();

  if (options.nameOnly) {
    for (const change of preview.changes) {
      out.log(change.path);
    }
    return;
  }

  if (preview.changes.length === 0) {
    out.success("No changes detected");
    await safeRepoShutdown(repo, "diff");
    out.exit();
    return;
  }

  out.warn(`${preview.changes.length} changes detected`);

  for (const change of preview.changes) {
    const prefix =
      change.changeType === "local_only"
        ? "[local]  "
        : change.changeType === "remote_only"
        ? "[remote] "
        : "[conflict]";

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
        out.log(`${prefix}${change.path} (content identical)`, "cyan");
        continue;
      }

      // Extract first hunk header and show inline with path
      let firstHunk = "";
      let diffLines = lines;
      if (lines[0]?.startsWith("@@")) {
        firstHunk = ` ${lines[0]}`;
        diffLines = lines.slice(1);
      }

      out.log(`${prefix}${change.path}${firstHunk}`, "cyan");

      for (const line of diffLines) {
        if (line.startsWith("@@")) {
          // Additional hunk headers
          out.log(line, "dim");
        } else if (line.startsWith("+")) {
          // Added line
          out.log(line, "green");
        } else if (line.startsWith("-")) {
          // Removed line
          out.log(line, "red");
        } else if (line.startsWith(" ") || line === "") {
          // Context line or empty
          out.log(line, "dim");
        }
      }
    } catch (error) {
      out.log(`${prefix}${change.path} (diff error: ${error})`, "cyan");
    }
  }

  await safeRepoShutdown(repo, "diff");
}

/**
 * Show sync status
 */
export async function status(
  targetPath: string = ".",
  options: StatusOptions = {}
): Promise<void> {
  const { repo, syncEngine, config } = await setupCommandContext(
    targetPath,
    false
  );
  const syncStatus = await syncEngine.getStatus();

  out.infoBlock("STATUS");

  const statusInfo: Record<string, any> = {};
  const fileCount = syncStatus.snapshot?.files.size || 0;

  statusInfo["URL"] = syncStatus.snapshot?.rootDirectoryUrl;
  statusInfo["Files"] = syncStatus.snapshot
    ? `${fileCount} tracked`
    : undefined;
  statusInfo["Sync"] = config?.sync_server;

  // Add more detailed info in verbose mode
  if (options.verbose && syncStatus.snapshot?.rootDirectoryUrl) {
    try {
      const rootHandle = await repo.find<DirectoryDocument>(
        syncStatus.snapshot.rootDirectoryUrl
      );
      const rootDoc = await rootHandle.doc();

      if (rootDoc) {
        statusInfo["Entries"] = rootDoc.docs.length;
        statusInfo["Directories"] = syncStatus.snapshot.directories.size;
        if (rootDoc.lastSyncAt) {
          const lastSyncDate = new Date(rootDoc.lastSyncAt);
          statusInfo["Last sync"] = lastSyncDate.toISOString();
        }
      }
    } catch (error) {
      out.warn(`Warning: Could not load detailed info: ${error}`);
    }
  }

  statusInfo["Changes"] = syncStatus.hasChanges
    ? `${syncStatus.changeCount} pending`
    : undefined;
  statusInfo["Status"] = !syncStatus.hasChanges ? "up to date" : undefined;

  out.obj(statusInfo);

  // Show verbose details if requested
  if (options.verbose && syncStatus.snapshot?.rootDirectoryUrl) {
    const rootHandle = await repo.find<DirectoryDocument>(
      syncStatus.snapshot.rootDirectoryUrl
    );
    const rootDoc = await rootHandle.doc();

    if (rootDoc) {
      out.infoBlock("HEADS");
      out.arr(rootHandle.heads());

      if (syncStatus.snapshot && syncStatus.snapshot.files.size > 0) {
        out.infoBlock("TRACKED FILES");
        const filesObj: Record<string, string> = {};
        syncStatus.snapshot.files.forEach((entry, filePath) => {
          filesObj[filePath] = entry.url;
        });
        out.obj(filesObj);
      }
    }
  }

  if (syncStatus.hasChanges && !options.verbose) {
    out.info("Run 'pushwork diff' to see changes");
  }

  await safeRepoShutdown(repo, "status");
}

/**
 * Show sync history
 */
export async function log(
  targetPath = ".",
  _options: LogOptions
): Promise<void> {
  const { repo: logRepo, workingDir } = await setupCommandContext(
    targetPath,
    false
  );

  // TODO: Implement history tracking
  const snapshotPath = path.join(workingDir, ".pushwork", "snapshot.json");
  if (await pathExists(snapshotPath)) {
    const stats = await fs.stat(snapshotPath);
    out.infoBlock("HISTORY", "Sync history (stub)");
    out.obj({ "Last sync": stats.mtime.toISOString() });
  } else {
    out.info("No sync history found");
  }

  await safeRepoShutdown(logRepo, "log");
}

/**
 * Checkout/restore from previous sync
 */
export async function checkout(
  syncId: string,
  targetPath = ".",
  _options: CheckoutOptions
): Promise<void> {
  const { workingDir } = await setupCommandContext(targetPath);

  // TODO: Implement checkout functionality
  out.warnBlock("NOT IMPLEMENTED", "Checkout not yet implemented");
  out.obj({
    "Sync ID": syncId,
    Path: workingDir,
  });
}

/**
 * Clone an existing synced directory from an AutomergeUrl
 */
export async function clone(
  rootUrl: string,
  targetPath: string,
  options: CloneOptions
): Promise<void> {
  const resolvedPath = path.resolve(targetPath);

  out.task(`Cloning ${rootUrl}`);

  // Check if directory exists and handle --force
  if (await pathExists(resolvedPath)) {
    const files = await fs.readdir(resolvedPath);
    if (files.length > 0 && !options.force) {
      out.error("Target directory is not empty. Use --force to overwrite");
      out.exit(1);
    }
  } else {
    await ensureDirectoryExists(resolvedPath);
  }

  // Check if already initialized
  const syncToolDir = path.join(resolvedPath, ".pushwork");
  if (await pathExists(syncToolDir)) {
    if (!options.force) {
      out.error("Directory already initialized. Use --force to overwrite");
      out.exit(1);
    }
    await fs.rm(syncToolDir, { recursive: true, force: true });
  }

  // Initialize repository with optional CLI overrides
  out.update("Setting up repository");
  const { config, repo, syncEngine } = await initializeRepository(
    resolvedPath,
    {
      sync_server: options.syncServer,
      sync_server_storage_id: options.syncServerStorageId,
    }
  );

  // Connect to existing root directory and download files
  out.update("Downloading files");
  await syncEngine.setRootDirectoryUrl(rootUrl as AutomergeUrl);
  const result = await syncEngine.sync();

  out.update("Writing to disk");
  await safeRepoShutdown(repo, "clone");

  out.done();

  out.obj({
    Path: resolvedPath,
    Files: `${result.filesChanged} downloaded`,
    Sync: config.sync_server,
  });
  out.successBlock("CLONED", rootUrl);
  process.exit();
}

/**
 * Get the root URL for the current pushwork repository
 */
export async function url(targetPath: string = "."): Promise<void> {
  const resolvedPath = path.resolve(targetPath);
  const syncToolDir = path.join(resolvedPath, ".pushwork");

  if (!(await pathExists(syncToolDir))) {
    out.error("Directory not initialized for sync");
    out.exit(1);
  }

  const snapshotPath = path.join(syncToolDir, "snapshot.json");
  if (!(await pathExists(snapshotPath))) {
    out.error("No snapshot found");
    out.exit(1);
  }

  const snapshotData = await fs.readFile(snapshotPath, "utf-8");
  const snapshot = JSON.parse(snapshotData);

  if (snapshot.rootDirectoryUrl) {
    // Output just the URL for easy use in scripts
    out.log(snapshot.rootDirectoryUrl);
  } else {
    out.error("No root URL found in snapshot");
    out.exit(1);
  }
}

/**
 * Remove local pushwork data and log URL for recovery
 */
export async function rm(targetPath: string = "."): Promise<void> {
  const resolvedPath = path.resolve(targetPath);
  const syncToolDir = path.join(resolvedPath, ".pushwork");

  if (!(await pathExists(syncToolDir))) {
    out.error("Directory not initialized for sync");
    out.exit(1);
  }

  // Read the URL before deletion for recovery
  let recoveryUrl = "";
  const snapshotPath = path.join(syncToolDir, "snapshot.json");
  if (await pathExists(snapshotPath)) {
    try {
      const snapshotData = await fs.readFile(snapshotPath, "utf-8");
      const snapshot = JSON.parse(snapshotData);
      recoveryUrl = snapshot.rootDirectoryUrl || null;
    } catch (error) {
      out.error(`Remove failed: ${error}`);
      out.exit(1);
      return;
    }
  }

  out.task("Removing local pushwork data");
  await fs.rm(syncToolDir, { recursive: true, force: true });
  out.done();

  out.warnBlock("REMOVED", recoveryUrl);
  process.exit();
}

export async function commit(
  targetPath: string,
  _options: CommandOptions = {}
): Promise<void> {
  out.task("Committing local changes");

  const { repo, syncEngine } = await setupCommandContext(targetPath, false);

  const result = await syncEngine.commitLocal();
  await safeRepoShutdown(repo, "commit");

  out.done();

  if (result.errors.length > 0) {
    out.errorBlock("ERROR", `${result.errors.length} errors`);
    result.errors.forEach((error) => out.error(error));
    out.exit(1);
  }

  out.successBlock("COMMITTED", `${result.filesChanged} files`);
  out.obj({
    Files: result.filesChanged,
    Directories: result.directoriesChanged,
  });

  if (result.warnings.length > 0) {
    result.warnings.forEach((warning) => out.warn(warning));
  }
  process.exit();
}

/**
 * List tracked files
 */
export async function ls(
  targetPath: string = ".",
  options: CommandOptions = {}
): Promise<void> {
  const { repo, syncEngine } = await setupCommandContext(targetPath, false);
  const syncStatus = await syncEngine.getStatus();

  if (!syncStatus.snapshot) {
    out.error("No snapshot found");
    await safeRepoShutdown(repo, "ls");
    out.exit(1);
    return;
  }

  const files = Array.from(syncStatus.snapshot.files.entries()).sort(
    ([pathA], [pathB]) => pathA.localeCompare(pathB)
  );

  if (files.length === 0) {
    out.info("No tracked files");
    await safeRepoShutdown(repo, "ls");
    return;
  }

  if (options.verbose) {
    // Long format with URLs
    for (const [filePath, entry] of files) {
      const url = entry?.url || "unknown";
      out.log(`${filePath} -> ${url}`);
    }
  } else {
    // Simple list
    for (const [filePath] of files) {
      out.log(filePath);
    }
  }

  await safeRepoShutdown(repo, "ls");
}

/**
 * View or edit configuration
 */
export async function config(
  targetPath: string = ".",
  options: ConfigOptions = {}
): Promise<void> {
  const resolvedPath = path.resolve(targetPath);
  const syncToolDir = path.join(resolvedPath, ".pushwork");

  if (!(await pathExists(syncToolDir))) {
    out.error("Directory not initialized for sync");
    out.exit(1);
  }

  const configManager = new ConfigManager(resolvedPath);
  const config = await configManager.getMerged();

  if (options.list) {
    // List all configuration
    out.infoBlock("CONFIGURATION", "Full configuration");
    out.log(JSON.stringify(config, null, 2));
  } else if (options.get) {
    // Get specific config value
    const keys = options.get.split(".");
    let value: any = config;
    for (const key of keys) {
      value = value?.[key];
    }
    if (value !== undefined) {
      out.log(
        typeof value === "object" ? JSON.stringify(value, null, 2) : value
      );
    } else {
      out.error(`Config key not found: ${options.get}`);
      out.exit(1);
    }
  } else {
    // Show basic config info
    out.infoBlock("CONFIGURATION");
    out.obj({
      "Sync server": config.sync_server || "default",
      "Sync enabled": config.sync_enabled ? "yes" : "no",
      Exclusions: config.defaults.exclude_patterns.length,
    });
    out.log("");
    out.log("Use --list to see full configuration");
  }
}

/**
 * Watch a directory and sync after build script completes
 */
export async function watch(
  targetPath: string = ".",
  options: WatchOptions = {}
): Promise<void> {
  const script = options.script || "pnpm build";
  const watchDir = options.watchDir || "src"; // Default to watching 'src' directory
  const verbose = options.verbose || false;
  const { repo, syncEngine, workingDir } = await setupCommandContext(
    targetPath
  );

  const absoluteWatchDir = path.resolve(workingDir, watchDir);

  // Check if watch directory exists
  if (!(await pathExists(absoluteWatchDir))) {
    out.error(`Watch directory does not exist: ${watchDir}`);
    await safeRepoShutdown(repo, "watch");
    out.exit(1);
    return;
  }

  out.spicyBlock(
    "WATCHING",
    `${chalk.underline(formatRelativePath(watchDir))} for changes...`
  );
  out.info(`Build script: ${script}`);
  out.info(`Working directory: ${workingDir}`);

  let isProcessing = false;
  let pendingChange = false;

  // Function to run build and sync
  const runBuildAndSync = async () => {
    if (isProcessing) {
      pendingChange = true;
      return;
    }

    isProcessing = true;
    pendingChange = false;

    try {
      out.spicy(`[${new Date().toLocaleTimeString()}] Changes detected...`);
      // Run build script
      const buildResult = await runScript(script, workingDir, verbose);

      if (!buildResult.success) {
        out.warn("Build script failed");
        if (buildResult.output) {
          out.log("");
          out.log(buildResult.output);
        }
        isProcessing = false;
        if (pendingChange) {
          setImmediate(() => runBuildAndSync());
        }
        return;
      }

      out.info("Build completed...");

      // Run sync
      out.task("Syncing");
      const result = await syncEngine.sync();

      if (result.success) {
        if (result.filesChanged === 0 && result.directoriesChanged === 0) {
          out.done("Already synced");
        } else {
          out.done(
            `Synced ${result.filesChanged} ${plural(
              "file",
              result.filesChanged
            )}`
          );
        }
      } else {
        out.warn(
          `⚠ Partial sync: ${result.filesChanged} updated, ${result.errors.length} errors`
        );
        result.errors
          .slice(0, 3)
          .forEach((error) =>
            out.error(`  ${error.path}: ${error.error.message}`)
          );
        if (result.errors.length > 3) {
          out.warn(`  ... and ${result.errors.length - 3} more errors`);
        }
      }

      if (result.warnings.length > 0) {
        result.warnings
          .slice(0, 3)
          .forEach((warning) => out.warn(`  ${warning}`));
        if (result.warnings.length > 3) {
          out.warn(`  ... and ${result.warnings.length - 3} more warnings`);
        }
      }
    } catch (error) {
      out.error(`Error during build/sync: ${error}`);
    } finally {
      isProcessing = false;

      // If changes occurred while we were processing, run again
      if (pendingChange) {
        setImmediate(() => runBuildAndSync());
      }
    }
  };

  // Set up file watcher - watches everything in the specified directory
  const watcher = fsSync.watch(
    absoluteWatchDir,
    { recursive: true },
    (_eventType, filename) => {
      if (filename) {
        runBuildAndSync();
      }
    }
  );

  // Handle graceful shutdown
  const shutdown = async () => {
    out.log("");
    out.info("Shutting down...");
    watcher.close();
    await safeRepoShutdown(repo, "watch");
    out.rainbow("Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Run initial build and sync
  await runBuildAndSync();

  // Keep process alive
  await new Promise(() => {}); // Never resolves, keeps watching
}

/**
 * Run a shell script and wait for completion
 */
async function runScript(
  script: string,
  cwd: string,
  verbose: boolean
): Promise<{ success: boolean; output?: string }> {
  return new Promise((resolve) => {
    const [command, ...args] = script.split(" ");
    const child = spawn(command, args, {
      cwd,
      stdio: verbose ? "inherit" : "pipe", // Show output directly if verbose, otherwise capture
      shell: true,
    });

    let output = "";

    // Capture output if not verbose (so we can show it on error)
    if (!verbose) {
      child.stdout?.on("data", (data) => {
        output += data.toString();
      });
      child.stderr?.on("data", (data) => {
        output += data.toString();
      });
    }

    child.on("close", (code) => {
      resolve({
        success: code === 0,
        output: !verbose ? output : undefined,
      });
    });

    child.on("error", (error) => {
      out.error(`Failed to run script: ${error.message}`);
      resolve({
        success: false,
        output: !verbose ? output : undefined,
      });
    });
  });
}

// TODO: Add push and pull commands later

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
