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
} from "./cli/commands";

const program = new Command();

program
  .name("sync-tool")
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
  sync-tool init ./my-folder
  sync-tool init ./my-folder --sync-server ws://localhost:3030 --sync-server-storage-id 1d89eba7-f7a4-4e8e-80f2-5f4e2406f507
  
Note: Custom sync server options must always be used together.`
  )
  .action(async (path: string, options) => {
    try {
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
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Clone command
program
  .command("clone")
  .description("Clone an existing synced directory")
  .argument("<url>", "AutomergeUrl of root directory to clone")
  .argument("<path>", "Target directory path")
  .option("--force", "Overwrite existing directory")
  .action(async (url: string, path: string, options) => {
    try {
      await clone(url, path, {
        force: options.force || false,
        dryRun: false,
        verbose: false,
      });
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Commit command
program
  .command("commit")
  .description("Commit local changes (no network sync)")
  .argument("[path]", "Directory path to commit", ".")
  .option("--dry-run", "Show what would be committed without applying changes")
  .action(async (path: string, options) => {
    try {
      await commit(path, options.dryRun || false);
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Sync command
program
  .command("sync")
  .description("Run full bidirectional synchronization")
  .option("--dry-run", "Show what would be done without applying changes")
  .option("--local-only", "Disable network sync (local-only mode)")
  .option("-v, --verbose", "Verbose output")
  .action(async (options) => {
    try {
      await sync({
        dryRun: options.dryRun || false,
        verbose: options.verbose || false,
        localOnly: options.localOnly || false,
      });
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Diff command
program
  .command("diff")
  .description("Show changes in working directory since last sync")
  .argument("[path]", "Limit diff to specific path", ".")
  .option("--tool <tool>", "Use external diff tool (meld, vimdiff, etc.)")
  .option("--name-only", "Show only changed file names")
  .option("--local-only", "Disable network sync (local-only mode)")
  .action(async (path: string, options) => {
    try {
      await diff(path, {
        tool: options.tool,
        nameOnly: options.nameOnly || false,
        dryRun: false,
        verbose: false,
        localOnly: options.localOnly || false,
      });
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Status command
program
  .command("status")
  .description("Show sync status summary")
  .option("--local-only", "Disable network sync (local-only mode)")
  .action(async (options) => {
    try {
      await status(options.localOnly || false);
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Log command
program
  .command("log")
  .description("Show sync history")
  .argument("[path]", "Show history for specific file or directory", ".")
  .option("--oneline", "Compact one-line per sync format")
  .option("--since <date>", "Show syncs since date")
  .option("--limit <n>", "Limit number of syncs shown", "10")
  .action(async (path: string, options) => {
    try {
      await log(path, {
        oneline: options.oneline || false,
        since: options.since,
        limit: parseInt(options.limit),
        dryRun: false,
        verbose: false,
      });
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

// Checkout command
program
  .command("checkout")
  .description("Restore directory to state from previous sync")
  .argument("<sync-id>", "Sync ID to restore to")
  .argument("[path]", "Specific path to restore", ".")
  .option("-f, --force", "Force checkout even if there are uncommitted changes")
  .action(async (syncId: string, path: string, options) => {
    try {
      await checkout(syncId, path, {
        force: options.force || false,
        dryRun: false,
        verbose: false,
      });
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    }
  });

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
