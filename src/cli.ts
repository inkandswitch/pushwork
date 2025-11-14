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
  rm,
  ls,
  config,
  watch,
} from "./commands";

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
  .version(version, "-V, --version", "output the version number");

// Configure help colors using Commander v13's built-in color support
program.configureHelp({
  styleTitle: (str) => chalk.bold(str),
  styleCommandText: (str) => chalk.white(str),
  styleCommandDescription: (str) => chalk.dim(str),
  styleDescriptionText: (str) => str,
  styleOptionText: (str) => chalk.green(str),
  styleArgumentText: (str) => chalk.cyan(str),
  styleSubcommandText: (str) => str, // Don't apply additional styling, we handle it in subcommandTerm
  // Custom subcommand term with manual color styling
  subcommandTerm: (cmd) => {
    const opts = cmd.options
      .filter((opt) => opt.flags !== "-h, --help")
      .map((opt) => opt.short || opt.long)
      .join(", ");

    // Apply colors manually: white for command, cyan for required args, dim for optional args
    const name = chalk.white(cmd.name());
    const args = cmd.registeredArguments
      .map((arg) =>
        arg.required
          ? chalk.cyan(`<${arg.name()}>`)
          : chalk.dim(`[${arg.name()}]`)
      )
      .join(" ");

    const baseTerm = args ? `${name} ${args}` : name;
    return opts ? `${baseTerm} ${chalk.dim(`[${opts}]`)}` : baseTerm;
  },
});

// Init command
program
  .command("init")
  .summary("Initialize sync in a directory")
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
  .summary("Clone an existing synced directory")
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
  .summary("Save local changes to Automerge documents")
  .argument(
    "[path]",
    "Directory path to commit (default: current directory)",
    "."
  )
  .option("--dry-run", "Show what would be committed without applying changes")
  .option("--debug", "Show detailed performance timing information")
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
  .summary("Run full bidirectional synchronization")
  .argument(
    "[path]",
    "Directory path to sync (default: current directory)",
    "."
  )
  .option("--dry-run", "Show what would be done without applying changes")
  .option("-v, --verbose", "Verbose output")
  .option("--debug", "Show detailed performance timing information")
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
  .summary("Show changes in working directory")
  .argument(
    "[path]",
    "Limit diff to specific path (default: current directory)",
    "."
  )
  .option("--name-only", "Show only changed file names")
  .action(
    withErrorHandling(async (path: string, options) => {
      await diff(path, {
        nameOnly: options.nameOnly || false,
        dryRun: false,
        verbose: false,
      });
    })
  );

// Status command
program
  .command("status")
  .summary("Show sync status summary")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .option(
    "-v, --verbose",
    "Show detailed status including document info and all tracked files"
  )
  .action(
    withErrorHandling(async (path: string, cmdOptions) => {
      await status(path, {
        verbose: cmdOptions.verbose || false,
      });
    })
  );

// Log command
program
  .command("log")
  .summary("Show sync history (experimental)")
  .argument(
    "[path]",
    "Show history for specific file or directory (default: current directory)",
    "."
  )
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
  .summary("Restore to previous sync (experimental)")
  .argument("<sync-id>", "Sync ID to restore to")
  .argument(
    "[path]",
    "Specific path to restore (default: current directory)",
    "."
  )
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
  .summary("Show the Automerge root URL")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .action(
    withErrorHandling(async (path: string) => {
      await url(path);
    })
  );

// Remove command
program
  .command("rm")
  .summary("Remove local pushwork data")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .action(
    withErrorHandling(async (path: string) => {
      await rm(path);
    })
  );

// List command
program
  .command("ls")
  .summary("List tracked files")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .option("-l, --long", "Show long format with Automerge URLs")
  .action(
    withErrorHandling(async (path: string, cmdOptions) => {
      await ls(path, {
        long: cmdOptions.long || false,
      });
    })
  );

// Config command
program
  .command("config")
  .summary("View or edit configuration")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .option("--list", "Show full configuration")
  .option(
    "--get <key>",
    "Get specific config value (dot notation, e.g., sync.move_detection_threshold)"
  )
  .option("--debug", "Show detailed performance timing information")
  .action(
    withErrorHandling(async (path: string, cmdOptions) => {
      await config(path, {
        list: cmdOptions.list || false,
        get: cmdOptions.get,
        debug: cmdOptions.debug || false,
      });
    })
  );

// Watch command
program
  .command("watch")
  .summary("Watch directory for changes, build, and sync")
  .argument(
    "[path]",
    "Directory path to sync (default: current directory)",
    "."
  )
  .option(
    "--script <command>",
    "Build script to run before syncing",
    "pnpm build"
  )
  .option(
    "--dir <dir>",
    "Directory to watch for changes (relative to working directory)",
    "src"
  )
  .option("-v, --verbose", "Show build script output")
  .action(
    withErrorHandling(async (path: string, cmdOptions) => {
      await watch(path, {
        script: cmdOptions.script,
        watchDir: cmdOptions.dir,
        dryRun: false,
        verbose: cmdOptions.verbose || false,
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
