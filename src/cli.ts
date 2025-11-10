#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import {
  init,
  clone,
  sync,
  diff,
  status,
  log,
  checkout,
  commit,
  url,
  debug,
  ls,
  config,
} from "./cli/commands";

/**
 * Wrapper for command actions with consistent error handling
 */
function withErrorHandling<T extends any[], R>(
  fn: (...args: T) => Promise<R>
): (...args: T) => Promise<void> {
  return async (...args: T): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  };
}

const program = new Command();

// get the version from the package.json
const version = require("../package.json").version;

program
  .name("pushwork")
  .description("Bidirectional directory synchronization using Automerge CRDTs")
  .version(version);

// Init command
program
  .command("init")
  .description("Initialize sync in directory")
  .argument(
    "[path]",
    "Directory path to initialize (default: current directory)",
    "."
  )
  .option(
    "--sync-server <url>",
    "Custom sync server URL (must be used with --sync-server-storage-id)"
  )
  .option(
    "--sync-server-storage-id <id>",
    "Custom sync server storage ID (must be used with --sync-server)"
  )
  .option("--debug", "Show detailed performance timing information")
  .addHelpText(
    "after",
    `
Examples:
  pushwork init                # Initialize current directory
  pushwork init ./my-folder    # Initialize specific directory
  pushwork init --debug        # Show performance breakdown
  pushwork init --sync-server ws://localhost:3030 --sync-server-storage-id 1d89eba7-f7a4-4e8e-80f2-5f4e2406f507
  
Note: Custom sync server options must always be used together.`
  )
  .action(
    withErrorHandling(async (path: string, cmdOptions) => {
      await init(path, {
        syncServer: cmdOptions.syncServer,
        syncServerStorageId: cmdOptions.syncServerStorageId,
        debug: cmdOptions.debug || false,
      });
    })
  );

// Clone command
program
  .command("clone")
  .description("Clone an existing synced directory")
  .argument(
    "<url>",
    "AutomergeUrl of root directory to clone (format: automerge:XXXXX)"
  )
  .argument("<path>", "Target directory path")
  .option("-f, --force", "Overwrite existing directory")
  .option(
    "--sync-server <url>",
    "Custom sync server URL (must be used with --sync-server-storage-id)"
  )
  .option(
    "--sync-server-storage-id <id>",
    "Custom sync server storage ID (must be used with --sync-server)"
  )
  .addHelpText(
    "after",
    `
Examples:
  pushwork clone automerge:abc123 ./my-clone
  pushwork clone automerge:abc123 ./my-clone -f
  pushwork clone automerge:abc123 ./my-clone --sync-server ws://localhost:3030 --sync-server-storage-id 1d89eba7-f7a4-4e8e-80f2-5f4e2406f507
  
Note: Custom sync server options must always be used together.`
  )
  .action(
    withErrorHandling(async (url: string, path: string, options) => {
      await clone(url, path, {
        force: options.force || false,
        dryRun: false,
        verbose: false,
        syncServer: options.syncServer,
        syncServerStorageId: options.syncServerStorageId,
      });
    })
  );

// Commit command
program
  .command("commit")
  .description("Save local changes to Automerge documents (offline operation)")
  .argument(
    "[path]",
    "Directory path to commit (default: current directory)",
    "."
  )
  .option("--dry-run", "Show what would be committed without applying changes")
  .option("--debug", "Show detailed performance timing information")
  .addHelpText(
    "after",
    `
Examples:
  pushwork commit              # Commit changes in current directory
  pushwork commit ./my-folder  # Commit changes in specific directory
  pushwork commit --dry-run    # Preview what would be committed`
  )
  .action(
    withErrorHandling(async (path: string, cmdOptions) => {
      await commit(path, {
        dryRun: cmdOptions.dryRun || false,
        debug: cmdOptions.debug || false,
      });
    })
  );

// Sync command
program
  .command("sync")
  .description("Run full bidirectional synchronization")
  .argument(
    "[path]",
    "Directory path to sync (default: current directory)",
    "."
  )
  .option("--dry-run", "Show what would be done without applying changes")
  .option("-v, --verbose", "Verbose output")
  .option("--debug", "Show detailed performance timing information")
  .addHelpText(
    "after",
    `
Examples:
  pushwork sync                # Sync current directory
  pushwork sync ./my-folder    # Sync specific directory
  pushwork sync --dry-run      # Preview changes without applying
  pushwork sync -v             # Sync with verbose output
  pushwork sync --debug        # Show performance breakdown`
  )
  .action(
    withErrorHandling(async (path: string, cmdOptions) => {
      await sync(path, {
        dryRun: cmdOptions.dryRun || false,
        verbose: cmdOptions.verbose || false,
        debug: cmdOptions.debug || false,
      });
    })
  );

// Diff command
program
  .command("diff")
  .description("Show changes in working directory since last sync")
  .argument(
    "[path]",
    "Limit diff to specific path (default: current directory)",
    "."
  )
  .option("--tool <tool>", "Use external diff tool (meld, vimdiff, etc.)")
  .option("--name-only", "Show only changed file names")
  .addHelpText(
    "after",
    `
Examples:
  pushwork diff                  # Show all changes
  pushwork diff ./src            # Show changes in src directory
  pushwork diff --name-only      # List changed files only
  pushwork diff --tool meld      # Use external diff tool`
  )
  .action(
    withErrorHandling(async (path: string, options) => {
      await diff(path, {
        tool: options.tool,
        nameOnly: options.nameOnly || false,
        dryRun: false,
        verbose: false,
      });
    })
  );

// Status command
program
  .command("status")
  .description("Show sync status summary")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .option("--debug", "Show detailed performance timing information")
  .addHelpText(
    "after",
    `
Examples:
  pushwork status              # Show status for current directory
  pushwork status ./my-folder  # Show status for specific directory`
  )
  .action(
    withErrorHandling(async (path: string) => {
      await status(path);
    })
  );

// Log command
program
  .command("log")
  .description("Show sync history (experimental)")
  .argument(
    "[path]",
    "Show history for specific file or directory (default: current directory)",
    "."
  )
  .option("--oneline", "Compact one-line per sync format")
  .option("--since <date>", "Show syncs since date")
  .option("--limit <n>", "Limit number of syncs shown", "10")
  .addHelpText(
    "after",
    `
Examples:
  pushwork log                 # Show recent sync history
  pushwork log --limit 20      # Show last 20 syncs
  pushwork log --oneline       # Compact format
  
Note: This command is experimental and shows limited history.`
  )
  .action(
    withErrorHandling(async (path: string, options) => {
      await log(path, {
        oneline: options.oneline || false,
        since: options.since,
        limit: parseInt(options.limit),
        dryRun: false,
        verbose: false,
      });
    })
  );

// Checkout command
program
  .command("checkout")
  .description("Restore directory to state from previous sync (experimental)")
  .argument("<sync-id>", "Sync ID to restore to")
  .argument(
    "[path]",
    "Specific path to restore (default: current directory)",
    "."
  )
  .option("-f, --force", "Force checkout even if there are uncommitted changes")
  .addHelpText(
    "after",
    `
Examples:
  pushwork checkout abc123      # Restore to sync abc123
  pushwork checkout abc123 -f   # Force restore
  
Note: This command is experimental and not fully implemented yet.`
  )
  .action(
    withErrorHandling(async (syncId: string, path: string, options) => {
      await checkout(syncId, path, {
        force: options.force || false,
        dryRun: false,
        verbose: false,
      });
    })
  );

// URL command
program
  .command("url")
  .description("Show the Automerge root URL for this repository")
  .argument("[path]", "Directory path", ".")
  .addHelpText(
    "after",
    `
Examples:
  pushwork url           # Show URL for current directory
  pushwork url ./repo    # Show URL for specific directory
  
Note: This command outputs only the URL, making it useful for scripts.`
  )
  .action(
    withErrorHandling(async (path: string) => {
      await url(path);
    })
  );

// Debug command
program
  .command("debug")
  .description("Show internal debug information including lastSyncAt timestamp")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .option(
    "-v, --verbose",
    "Show verbose debug information including full document contents"
  )
  .addHelpText(
    "after",
    `
Examples:
  pushwork debug           # Show debug info for current directory
  pushwork debug --verbose # Show verbose debug info including full document contents
  pushwork debug ./repo    # Show debug info for specific directory
  
This command displays internal document state, including the lastSyncAt timestamp
that gets updated when sync operations make changes.`
  )
  .action(
    withErrorHandling(async (path: string, options) => {
      await debug(path, {
        verbose: options.verbose || false,
      });
    })
  );

// List command
program
  .command("ls")
  .description("List tracked files in the repository")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .option("-l, --long", "Show long format with Automerge URLs")
  .option("--debug", "Show detailed performance timing information")
  .addHelpText(
    "after",
    `
Examples:
  pushwork ls              # List all tracked files
  pushwork ls -l           # List with Automerge URLs
  pushwork ls ./my-folder  # List files in specific directory`
  )
  .action(
    withErrorHandling(async (path: string, cmdOptions) => {
      await ls(path, {
        long: cmdOptions.long || false,
        debug: cmdOptions.debug || false,
      });
    })
  );

// Config command
program
  .command("config")
  .description("View or edit repository configuration")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .option("--list", "Show full configuration")
  .option(
    "--get <key>",
    "Get specific config value (dot notation, e.g., sync.auto_sync)"
  )
  .option("--debug", "Show detailed performance timing information")
  .addHelpText(
    "after",
    `
Examples:
  pushwork config              # Show basic configuration
  pushwork config --list       # Show full configuration as JSON
  pushwork config --get sync_server  # Get specific config value
  pushwork config --get defaults.exclude_patterns  # Get nested value`
  )
  .action(
    withErrorHandling(async (path: string, cmdOptions) => {
      await config(path, {
        list: cmdOptions.list || false,
        get: cmdOptions.get,
        debug: cmdOptions.debug || false,
      });
    })
  );

// Global error handler
process.on("unhandledRejection", (reason, promise) => {
  console.error(
    chalk.red("Unhandled Rejection at:"),
    promise,
    chalk.red("reason:"),
    reason
  );
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  // Ignore WebSocket errors during shutdown - they're non-critical
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (
    errorMessage.includes("WebSocket") ||
    errorMessage.includes("connection was established") ||
    errorMessage.includes("was closed")
  ) {
    // Silently ignore WebSocket shutdown errors
    return;
  }

  console.error(chalk.red("Uncaught Exception:"), error);
  process.exit(1);
});

// Parse arguments
program.parse();

// Show help if no arguments provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
