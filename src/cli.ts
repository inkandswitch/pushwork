#!/usr/bin/env node

import { Command } from "@commander-js/extra-typings";
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

const version = require("../package.json").version;
const program = new Command()
  .name("pushwork")
  .description("Bidirectional directory synchronization using Automerge CRDTs")
  .version(version, "-V, --version", "output the version number");

// Configure help colors using Commander v13's built-in color support
program.configureHelp({
  styleTitle: (str) => chalk.bold(str),
  styleCommandText: (str) => chalk.white(str),
  styleCommandDescription: (str) => chalk.dim(str),
  styleOptionText: (str) => chalk.green(str),
  styleArgumentText: (str) => chalk.cyan(str),
  subcommandTerm: (cmd) => {
    const opts = cmd.options
      .filter((opt) => opt.flags !== "-h, --help")
      .map((opt) => opt.short || opt.long)
      .join(", ");

    const name = chalk.white(cmd.name());
    const args = cmd.registeredArguments
      .map((arg) =>
        arg.required
          ? chalk.cyan(`<${arg.name()}>`)
          : chalk.dim(`[${arg.name()}]`)
      )
      .join(" ");

    return [name, args, opts && chalk.dim(`[${opts}]`)]
      .filter(Boolean)
      .join(" ");
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
  .action(async (path, opts) => {
    await init(path, {
      syncServer: opts.syncServer,
      syncServerStorageId: opts.syncServerStorageId as any,
    });
  });

// Clone command
program
  .command("clone")
  .summary("Clone an existing synced directory")
  .argument(
    "<url>",
    "AutomergeUrl of root directory to clone (format: automerge:XXXXX)"
  )
  .argument("<path>", "Target directory path")
  .option("-f, --force", "Overwrite existing directory", false)
  .option(
    "--sync-server <url>",
    "Custom sync server URL (must be used with --sync-server-storage-id)"
  )
  .option(
    "--sync-server-storage-id <id>",
    "Custom sync server storage ID (must be used with --sync-server)"
  )
  .option("-v, --verbose", "Verbose output", false)
  .action(async (url, path, opts) => {
    await clone(url, path, {
      force: opts.force,
      verbose: opts.verbose,
      syncServer: opts.syncServer,
      syncServerStorageId: opts.syncServerStorageId as any,
    });
  });

// Commit command
program
  .command("commit")
  .summary("Save local changes to Automerge documents")
  .argument(
    "[path]",
    "Directory path to commit (default: current directory)",
    "."
  )
  .action(async (path, _opts) => {
    await commit(path);
  });

// Sync command
program
  .command("sync")
  .summary("Run full bidirectional synchronization")
  .argument(
    "[path]",
    "Directory path to sync (default: current directory)",
    "."
  )
  .option(
    "--dry-run",
    "Show what would be done without applying changes",
    false
  )
  .option("-v, --verbose", "Verbose output", false)
  .action(async (path, opts) => {
    await sync(path, {
      dryRun: opts.dryRun,
      verbose: opts.verbose,
    });
  });

// Diff command
program
  .command("diff")
  .summary("Show changes in working directory")
  .argument(
    "[path]",
    "Limit diff to specific path (default: current directory)",
    "."
  )
  .option("--name-only", "Show only changed file names", false)
  .action(async (path, opts) => {
    await diff(path, {
      nameOnly: opts.nameOnly,
    });
  });

// Status command
program
  .command("status")
  .summary("Show sync status summary")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .option(
    "-v, --verbose",
    "Show detailed status including document info and all tracked files",
    false
  )
  .action(async (path, opts) => {
    await status(path, {
      verbose: opts.verbose,
    });
  });

// Log command
program
  .command("log")
  .summary("Show sync history (experimental)")
  .argument(
    "[path]",
    "Show history for specific file or directory (default: current directory)",
    "."
  )
  .option("--oneline", "Compact one-line per sync format", false)
  .option("--since <date>", "Show syncs since date")
  .option("--limit <n>", "Limit number of syncs shown", "10")
  .action(async (path, opts) => {
    await log(path, {
      oneline: opts.oneline,
      since: opts.since,
      limit: parseInt(opts.limit),
    });
  });

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
  .option(
    "-f, --force",
    "Force checkout even if there are uncommitted changes",
    false
  )
  .action(async (syncId, path, opts) => {
    await checkout(syncId, path, {
      force: opts.force,
    });
  });

// URL command
program
  .command("url")
  .summary("Show the Automerge root URL")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .action(async (path) => {
    await url(path);
  });

// Remove command
program
  .command("rm")
  .summary("Remove local pushwork data")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .action(async (path) => {
    await rm(path);
  });

// List command
program
  .command("ls")
  .summary("List tracked files")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .option("-v, --verbose", "Show with Automerge URLs", false)
  .action(async (path, opts) => {
    await ls(path, {
      verbose: opts.verbose,
    });
  });

// Config command
program
  .command("config")
  .summary("View or edit configuration")
  .argument("[path]", "Directory path (default: current directory)", ".")
  .option("--list", "Show full configuration", false)
  .option(
    "--get <key>",
    "Get specific config value (dot notation, e.g., sync.move_detection_threshold)"
  )
  .action(async (path, opts) => {
    await config(path, {
      list: opts.list,
      get: opts.get,
    });
  });

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
  .option("-v, --verbose", "Show build script output", false)
  .action(async (path, opts) => {
    await watch(path, {
      script: opts.script,
      watchDir: opts.dir,
      verbose: opts.verbose,
    });
  });

process.on("unhandledRejection", (error) => {
  console.log(chalk.bgRed.white(" ERROR "));
  if (error instanceof Error && error.stack) {
    console.log(chalk.red(error.stack));
  } else {
    console.error(chalk.red(error));
  }
  process.exit(1);
});

program.parseAsync();
