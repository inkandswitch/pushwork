import * as path from "path";
import * as fs from "fs/promises";
import { Repo, AutomergeUrl } from "@automerge/automerge-repo";
import * as diffLib from "diff";
import {
  CloneOptions,
  SyncOptions,
  DiffOptions,
  LogOptions,
  CheckoutOptions,
  InitOptions,
  CommitOptions,
  ListOptions,
  ConfigOptions,
  DebugOptions,
  DirectoryConfig,
  DirectoryDocument,
} from "../types";
import { SyncEngine } from "../core";
import { pathExists, ensureDirectoryExists } from "../utils";
import { ConfigManager } from "../config";
import { createRepo } from "../utils/repo-factory";
import { Output } from "./output";
import { trace, span } from "../tracing";

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
 * Create default DirectoryConfig with optional sync server overrides
 */
function createDefaultConfig(
  syncServer?: string,
  syncServerStorageId?: string
): DirectoryConfig {
  const defaultSyncServer = syncServer || "wss://sync3.automerge.org";
  const defaultStorageId =
    syncServerStorageId || "3760df37-a4c6-4f66-9ecd-732039a9385d";

  return {
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
async function setupCommandContext(
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
  // Validate sync server options
  validateSyncServerOptions(options.syncServer, options.syncServerStorageId);

  // Enable tracing if debug mode
  if (options.debug) {
    trace(true);
  }

  const out = new Output();

  try {
    const resolvedPath = path.resolve(targetPath);

    out.task(`Initializing`);

    await ensureDirectoryExists(resolvedPath);

    // Check if already initialized
    const syncToolDir = path.join(resolvedPath, ".pushwork");
    if (await pathExists(syncToolDir)) {
      out.error("Directory already initialized for sync");
      out.exit(1);
    }

    out.update("Creating sync directory");
    await ensureDirectoryExists(syncToolDir);
    await ensureDirectoryExists(path.join(syncToolDir, "automerge"));

    out.update("Setting up configuration");
    const configManager = new ConfigManager(resolvedPath);
    const defaultSyncServer = options.syncServer || "wss://sync3.automerge.org";
    const defaultStorageId =
      options.syncServerStorageId || "3760df37-a4c6-4f66-9ecd-732039a9385d";
    const config = createDefaultConfig(
      options.syncServer,
      options.syncServerStorageId
    );
    await configManager.save(config);

    out.update("Creating root directory");
    const repo = await createRepo(resolvedPath, {
      enableNetwork: true,
      syncServer: options.syncServer,
      syncServerStorageId: options.syncServerStorageId,
    });

    const rootDoc: DirectoryDocument = {
      "@patchwork": { type: "folder" },
      docs: [],
    };
    const rootHandle = repo.create(rootDoc);

    out.update("Scanning existing files");
    const syncEngine = new SyncEngine(
      repo,
      resolvedPath,
      config.defaults.exclude_patterns,
      true,
      defaultStorageId
    );

    await syncEngine.setRootDirectoryUrl(rootHandle.url);
    const result = await span("sync", syncEngine.sync());

    out.update("Writing to disk");
    await safeRepoShutdown(repo, "init");

    out.done();

    out.pair("Sync", defaultSyncServer);
    if (result.filesChanged > 0) {
      out.pair("Files", `${result.filesChanged} added`);
    }
    out.success("INITIALIZED", rootHandle.url);

    // Export flame graph if debug mode is enabled
    if (options.debug) {
      const tracer = trace(false);
      const traceFile = path.join(resolvedPath, ".pushwork", "trace.json");
      await fs.writeFile(
        traceFile,
        JSON.stringify(tracer.toChromeTrace(), null, 2)
      );

      out.log("");
      out.special(
        `FLAME GRAPH`,
        `file://${traceFile} (Open in https://ui.perfetto.dev)`
      );
    }
  } catch (error) {
    out.error("FAILED", "Initialization failed");
    out.log(`  ${error}`);
    out.exit(1);
  }
  process.exit();
}

/**
 * Run bidirectional sync
 */
export async function sync(
  targetPath = ".",
  options: SyncOptions
): Promise<void> {
  // Enable tracing if debug mode
  if (options.debug) {
    trace(true);
  }

  const out = new Output();

  try {
    out.task("Syncing");

    const { repo, syncEngine, workingDir } = await setupCommandContext(
      targetPath
    );

    if (options.dryRun) {
      out.update("Analyzing changes");
      const preview = await syncEngine.previewChanges();

      out.done();

      if (preview.changes.length === 0 && preview.moves.length === 0) {
        out.info("No changes detected");
        out.log("Everything is already in sync");
        return;
      }

      out.info("CHANGES", "Pending");
      out.pair("Directory", workingDir);
      out.pair("Changes", preview.changes.length.toString());
      if (preview.moves.length > 0) {
        out.pair("Moves", preview.moves.length.toString());
      }

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
      out.update("Synchronizing");
      const result = await span("sync", syncEngine.sync());

      out.update("Writing to disk");
      await safeRepoShutdown(repo, "sync");

      if (result.success) {
        if (result.filesChanged === 0 && result.directoriesChanged === 0) {
          out.done();
          out.success("Already in sync");
        } else {
          out.done();
          out.success(
            "SYNCED",
            `${result.filesChanged} file${
              result.filesChanged !== 1 ? "s" : ""
            } updated`
          );
          out.pair("Files", result.filesChanged.toString());
        }

        if (result.warnings.length > 0) {
          out.log("");
          out.warn("WARNINGS", `${result.warnings.length} warnings`);
          for (const warning of result.warnings.slice(0, 5)) {
            out.log(`  ${warning}`);
          }
          if (result.warnings.length > 5) {
            out.log(`  ... and ${result.warnings.length - 5} more`);
          }
        }

        // Export flame graph if debug mode is enabled
        if (options.debug) {
          const tracer = trace(false);
          const traceFile = path.join(workingDir, ".pushwork", "trace.json");
          await fs.writeFile(
            traceFile,
            JSON.stringify(tracer.toChromeTrace(), null, 2)
          );

          out.log("");
          out.special(
            `FLAME GRAPH`,
            `file://${traceFile} (Open in https://ui.perfetto.dev)`
          );
        }
      } else {
        out.done("partial", false);
        out.warn(
          "PARTIAL",
          `${result.filesChanged} updated, ${result.errors.length} errors`
        );
        out.pair("Files", result.filesChanged.toString());
        out.pair("Errors", result.errors.length.toString());

        out.log("");
        for (const error of result.errors.slice(0, 5)) {
          out.error("ERROR", error.path);
          out.log(`  ${error.error.message}`);
          out.log("");
        }
        if (result.errors.length > 5) {
          out.log(`... and ${result.errors.length - 5} more errors`);
        }
      }
    }
  } catch (error) {
    out.error("FAILED", "Sync failed");
    out.log(`  ${error}`);
    out.exit(1);
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
  const out = new Output();

  try {
    out.task("Analyzing changes");

    const { repo, syncEngine } = await setupCommandContext(
      targetPath,
      undefined,
      undefined,
      false
    );
    const preview = await syncEngine.previewChanges();

    out.done();

    if (options.nameOnly) {
      for (const change of preview.changes) {
        console.log(change.path);
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

      if (!options.tool) {
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
      } else {
        out.log(`${prefix} ${change.path}`);
      }
    }

    await safeRepoShutdown(repo, "diff");
  } catch (error) {
    out.error(`Diff failed: ${error}`);
    out.exit(1);
  }
}

/**
 * Show sync status
 */
export async function status(targetPath: string = "."): Promise<void> {
  const out = new Output();

  try {
    out.task("Loading status");

    const { repo, syncEngine, workingDir, config } = await setupCommandContext(
      targetPath,
      undefined,
      undefined,
      false
    );
    const syncStatus = await syncEngine.getStatus();

    out.done();

    out.info("STATUS", workingDir);

    if (syncStatus.snapshot?.rootDirectoryUrl) {
      out.pair("URL", syncStatus.snapshot.rootDirectoryUrl);
    }

    if (syncStatus.snapshot) {
      const fileCount = syncStatus.snapshot.files.size;
      out.pair("Files", `${fileCount} tracked`);
    }

    out.pair("Sync", config?.sync_server || "wss://sync3.automerge.org");

    if (syncStatus.hasChanges) {
      out.pair("Changes", `${syncStatus.changeCount} pending`);
      out.log("");
      out.log("Run 'pushwork diff' to see changes");
    } else {
      out.pair("Status", "up to date");
    }

    await safeRepoShutdown(repo, "status");
  } catch (error) {
    out.error(`Status check failed: ${error}`);
    out.exit(1);
  }
}

/**
 * Show sync history
 */
export async function log(
  targetPath = ".",
  _options: LogOptions
): Promise<void> {
  const out = new Output();

  try {
    const { repo: logRepo, workingDir } = await setupCommandContext(
      targetPath,
      undefined,
      undefined,
      false
    );

    // TODO: Implement history tracking
    const snapshotPath = path.join(workingDir, ".pushwork", "snapshot.json");
    if (await pathExists(snapshotPath)) {
      const stats = await fs.stat(snapshotPath);
      out.info("HISTORY", "Sync history (stub)");
      out.pair("Last sync", stats.mtime.toISOString());
    } else {
      out.info("No sync history found");
    }

    await safeRepoShutdown(logRepo, "log");
  } catch (error) {
    out.error(`Log failed: ${error}`);
    out.exit(1);
  }
}

/**
 * Checkout/restore from previous sync
 */
export async function checkout(
  syncId: string,
  targetPath = ".",
  _options: CheckoutOptions
): Promise<void> {
  const out = new Output();

  try {
    const { workingDir } = await setupCommandContext(targetPath);

    // TODO: Implement checkout functionality
    out.warn("NOT IMPLEMENTED", "Checkout not yet implemented");
    out.pair("Sync ID", syncId);
    out.pair("Path", workingDir);
  } catch (error) {
    out.error(`Checkout failed: ${error}`);
    out.exit(1);
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

  const out = new Output();

  try {
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

    out.update("Creating sync directory");
    await ensureDirectoryExists(syncToolDir);
    await ensureDirectoryExists(path.join(syncToolDir, "automerge"));

    out.update("Setting up configuration");
    const configManager = new ConfigManager(resolvedPath);
    const defaultSyncServer = options.syncServer || "wss://sync3.automerge.org";
    const defaultStorageId =
      options.syncServerStorageId || "3760df37-a4c6-4f66-9ecd-732039a9385d";
    const config = createDefaultConfig(
      options.syncServer,
      options.syncServerStorageId
    );
    await configManager.save(config);

    out.update("Connecting to sync server");
    const repo = await createRepo(resolvedPath, {
      enableNetwork: true,
      syncServer: options.syncServer,
      syncServerStorageId: options.syncServerStorageId,
    });

    out.update("Downloading files");
    const syncEngine = new SyncEngine(
      repo,
      resolvedPath,
      config.defaults.exclude_patterns,
      true,
      defaultStorageId
    );

    await syncEngine.setRootDirectoryUrl(rootUrl as AutomergeUrl);
    const result = await span("sync", syncEngine.sync());

    out.update("Writing to disk");
    await safeRepoShutdown(repo, "clone");

    out.done();

    out.pair("Path", resolvedPath);
    out.pair("Files", `${result.filesChanged} downloaded`);
    out.pair("Sync", defaultSyncServer);
    out.success("CLONED", rootUrl);
  } catch (error) {
    out.error("FAILED", "Clone failed");
    out.log(`  ${error}`);
    out.exit(1);
  }
  process.exit();
}

/**
 * Get the root URL for the current pushwork repository
 */
export async function url(targetPath: string = "."): Promise<void> {
  const out = new Output();

  try {
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
      console.log(snapshot.rootDirectoryUrl);
    } else {
      out.error("No root URL found in snapshot");
      out.exit(1);
    }
  } catch (error) {
    out.error(`Failed to get URL: ${error}`);
    out.exit(1);
  }
}

/**
 * Remove local pushwork data and log URL for recovery
 */
export async function rm(targetPath: string = "."): Promise<void> {
  const out = new Output();

  try {
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

    out.success("REMOVED", recoveryUrl);
  } catch (error) {
    out.error(`Remove failed: ${error}`);
    out.exit(1);
  }
  process.exit();
}

export async function commit(
  targetPath: string,
  _options: CommitOptions = {}
): Promise<void> {
  const out = new Output();

  try {
    out.task("Committing local changes");

    const { repo, syncEngine } = await setupCommandContext(
      targetPath,
      undefined,
      undefined,
      false
    );

    const result = await syncEngine.commitLocal();
    await safeRepoShutdown(repo, "commit");

    out.done();

    if (result.errors.length > 0) {
      out.error("ERRORS", `${result.errors.length} errors`);
      result.errors.forEach((error) => {
        out.log(`  ${error.path}: ${error.error.message}`);
      });
      out.exit(1);
    }

    out.success("COMMITTED", `${result.filesChanged} files committed`);
    out.pair("Files", result.filesChanged.toString());
    out.pair("Directories", result.directoriesChanged.toString());

    if (result.warnings.length > 0) {
      out.log("");
      out.warn("WARNINGS", `${result.warnings.length} warnings`);
      result.warnings.forEach((warning: string) => out.log(`  ${warning}`));
    }
  } catch (error) {
    out.error(`Commit failed: ${error}`);
    out.exit(1);
  }
  process.exit();
}

/**
 * Debug command to inspect internal document state
 */
export async function debug(
  targetPath: string = ".",
  options: DebugOptions = {}
): Promise<void> {
  const out = new Output();

  try {
    out.task("Loading debug info");

    const { repo, syncEngine, workingDir } = await setupCommandContext(
      targetPath,
      undefined,
      undefined,
      false
    );
    const debugStatus = await syncEngine.getStatus();

    out.done("done");

    out.info("DEBUG", workingDir);

    if (debugStatus.snapshot?.rootDirectoryUrl) {
      out.pair("URL", debugStatus.snapshot.rootDirectoryUrl);

      try {
        const rootHandle = await repo.find<DirectoryDocument>(
          debugStatus.snapshot.rootDirectoryUrl
        );
        const rootDoc = await rootHandle.doc();

        if (rootDoc) {
          out.pair("Entries", rootDoc.docs.length.toString());
          if (rootDoc.lastSyncAt) {
            const lastSyncDate = new Date(rootDoc.lastSyncAt);
            out.pair("Last sync", lastSyncDate.toISOString());
          }

          if (options.verbose) {
            out.log("");
            out.log("Document:");
            out.log(JSON.stringify(rootDoc, null, 2));
            out.log("");
            out.log("Heads:");
            out.log(JSON.stringify(rootHandle.heads(), null, 2));
          }
        }
      } catch (error) {
        out.warn(`Error loading root document: ${error}`);
      }
    }

    if (debugStatus.snapshot) {
      out.pair("Files", debugStatus.snapshot.files.size.toString());
      out.pair("Directories", debugStatus.snapshot.directories.size.toString());

      if (options.verbose) {
        out.log("");
        out.log("All tracked files:");
        debugStatus.snapshot.files.forEach((entry, filePath) => {
          out.log(`  ${filePath} -> ${entry.url}`);
        });
      }
    }

    await safeRepoShutdown(repo, "debug");
  } catch (error) {
    out.error(`Debug failed: ${error}`);
    out.exit(1);
  }
}

/**
 * List tracked files
 */
export async function ls(
  targetPath: string = ".",
  options: ListOptions = {}
): Promise<void> {
  const out = new Output();

  try {
    const { repo, syncEngine } = await setupCommandContext(
      targetPath,
      undefined,
      undefined,
      false
    );
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

    if (options.long) {
      // Long format with URLs
      for (const [filePath, entry] of files) {
        const url = entry?.url || "unknown";
        console.log(`${filePath} -> ${url}`);
      }
    } else {
      // Simple list
      for (const [filePath] of files) {
        console.log(filePath);
      }
    }

    await safeRepoShutdown(repo, "ls");
  } catch (error) {
    out.error(`List failed: ${error}`);
    out.exit(1);
  }
}

/**
 * View or edit configuration
 */
export async function config(
  targetPath: string = ".",
  options: ConfigOptions = {}
): Promise<void> {
  const out = new Output();

  try {
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
      out.info("CONFIGURATION", "Full configuration");
      out.log(JSON.stringify(config, null, 2));
    } else if (options.get) {
      // Get specific config value
      const keys = options.get.split(".");
      let value: any = config;
      for (const key of keys) {
        value = value?.[key];
      }
      if (value !== undefined) {
        console.log(
          typeof value === "object" ? JSON.stringify(value, null, 2) : value
        );
      } else {
        out.error(`Config key not found: ${options.get}`);
        out.exit(1);
      }
    } else {
      // Show basic config info
      out.info("CONFIGURATION", resolvedPath);
      out.pair("Sync server", config.sync_server || "default");
      out.pair("Sync enabled", config.sync_enabled ? "yes" : "no");
      out.pair(
        "Exclusions",
        config.defaults.exclude_patterns.length.toString()
      );
      out.log("");
      out.log("Use --list to see full configuration");
    }
  } catch (error) {
    out.error(`Config failed: ${error}`);
    out.exit(1);
  }
}

// TODO: Add push and pull commands later
