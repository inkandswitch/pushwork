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

program
  .name("pushwork")
  .description("Bidirectional directory synchronization using Automerge CRDTs")
  .version("1.0.0");

// Init command
program
  .command("init")
  .description("Initialize sync in directory")
  .argument("<path>", "Directory path to initialize")
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
  pushwork init ./my-folder
  pushwork init ./my-folder --sync-server ws://localhost:3030 --sync-server-storage-id 1d89eba7-f7a4-4e8e-80f2-5f4e2406f507
  
Note: Custom sync server options must always be used together.`
  )
  .action(
    withErrorHandling(async (path: string, options) => {
      // Validate that both sync server options are provided together
      const hasSyncServer = !!options.syncServer;
      const hasSyncServerStorageId = !!options.syncServerStorageId;

      if (hasSyncServer && !hasSyncServerStorageId) {
        console.error(
          chalk.red("Error: --sync-server requires --sync-server-storage-id")
        );
        console.error(
          chalk.yellow("Both arguments must be provided together.")
        );
        process.exit(1);
      }

      if (hasSyncServerStorageId && !hasSyncServer) {
        console.error(
          chalk.red("Error: --sync-server-storage-id requires --sync-server")
        );
        console.error(
          chalk.yellow("Both arguments must be provided together.")
        );
        process.exit(1);
      }

      await init(path, options.syncServer, options.syncServerStorageId);
    })
  );

// Clone command
program
  .command("clone")
  .description("Clone an existing synced directory")
  .argument("<url>", "AutomergeUrl of root directory to clone")
  .argument("<path>", "Target directory path")
  .option("--force", "Overwrite existing directory")
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
  pushwork clone automerge:abc123 ./my-clone --force
  pushwork clone automerge:abc123 ./my-clone --sync-server ws://localhost:3030 --sync-server-storage-id 1d89eba7-f7a4-4e8e-80f2-5f4e2406f507
  
Note: Custom sync server options must always be used together.`
  )
  .action(
    withErrorHandling(async (url: string, path: string, options) => {
      // Validate that both sync server options are provided together
      const hasSyncServer = !!options.syncServer;
      const hasSyncServerStorageId = !!options.syncServerStorageId;

      if (hasSyncServer && !hasSyncServerStorageId) {
        console.error(
          chalk.red("Error: --sync-server requires --sync-server-storage-id")
        );
        console.error(
          chalk.yellow("Both arguments must be provided together.")
        );
        process.exit(1);
      }

      if (hasSyncServerStorageId && !hasSyncServer) {
        console.error(
          chalk.red("Error: --sync-server-storage-id requires --sync-server")
        );
        console.error(
          chalk.yellow("Both arguments must be provided together.")
        );
        process.exit(1);
      }

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
  .description("Commit local changes (no network sync)")
  .argument("[path]", "Directory path to commit", ".")
  .option("--dry-run", "Show what would be committed without applying changes")
  .action(
    withErrorHandling(async (path: string, options) => {
      await commit(path, options.dryRun || false);
    })
  );

// Sync command
program
  .command("sync")
  .description("Run full bidirectional synchronization")
  .option("--dry-run", "Show what would be done without applying changes")
  .option("-v, --verbose", "Verbose output")
  .action(
    withErrorHandling(async (options) => {
      await sync({
        dryRun: options.dryRun || false,
        verbose: options.verbose || false,
      });
    })
  );

// Diff command
program
  .command("diff")
  .description("Show changes in working directory since last sync")
  .argument("[path]", "Limit diff to specific path", ".")
  .option("--tool <tool>", "Use external diff tool (meld, vimdiff, etc.)")
  .option("--name-only", "Show only changed file names")
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
  .action(
    withErrorHandling(async (options) => {
      await status();
    })
  );

// Log command
program
  .command("log")
  .description("Show sync history")
  .argument("[path]", "Show history for specific file or directory", ".")
  .option("--oneline", "Compact one-line per sync format")
  .option("--since <date>", "Show syncs since date")
  .option("--limit <n>", "Limit number of syncs shown", "10")
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
  .description("Restore directory to state from previous sync")
  .argument("<sync-id>", "Sync ID to restore to")
  .argument("[path]", "Specific path to restore", ".")
  .option("-f, --force", "Force checkout even if there are uncommitted changes")
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
  console.error(chalk.red("Uncaught Exception:"), error);
  process.exit(1);
});

// Parse arguments
program.parse();

// Show help if no arguments provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
