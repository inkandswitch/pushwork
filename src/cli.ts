#!/usr/bin/env node

import { StorageId } from "@automerge/automerge-repo";
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
    "--sync-server <url> <storage-id...>",
    "Custom sync server URL and storage ID"
  )
  .action(async (path, opts) => {
    const [syncServer, syncServerStorageId] = validateSyncServer(
      opts.syncServer
    );
    await init(path, { syncServer, syncServerStorageId });
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
    "--sync-server <url> <storage-id...>",
    "Custom sync server URL and storage ID"
  )
  .option("-v, --verbose", "Verbose output", false)
  .action(async (url, path, opts) => {
    const [syncServer, syncServerStorageId] = validateSyncServer(
      opts.syncServer
    );
    await clone(url, path, {
      force: opts.force,
      verbose: opts.verbose,
      syncServer,
      syncServerStorageId,
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
  .option(
    "-f, --force",
    "Ignore config files and sync with default settings",
    false
  )
  .option("-v, --verbose", "Verbose output", false)
  .action(async (path, opts) => {
    await sync(path, {
      dryRun: opts.dryRun,
      force: opts.force,
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

// Completion command (hidden from help)
program.command("completion", { hidden: true }).action(() => {
  // Generate completion dynamically from registered commands
  const commands = program.commands
    .filter((cmd) => cmd.name() !== "completion") // Exclude self
    .map((cmd) => {
      const name = cmd.name();
      const desc = (cmd.summary() || cmd.description() || "").replace(
        /'/g,
        "\\'"
      );
      return `'${name}:${desc}'`;
    })
    .join(" ");

  // Generate option completions for each command
  const commandCases = program.commands
    .filter((cmd) => cmd.name() !== "completion")
    .map((cmd) => {
      const options = cmd.options
        .filter((opt) => opt.flags !== "-h, --help") // Exclude help
        .map((opt) => {
          // Parse flags like "-v, --verbose" or "--dry-run"
          const flags = opt.flags.split(",").map((f) => f.trim());
          const desc = (opt.description || "")
            .replace(/'/g, "\\'")
            .replace(/\n/g, " ");

          // For options with arguments like "--sync-server <url>"
          // Extract just the flag part
          const cleanFlags = flags.map((f) => f.split(/\s+/)[0]);

          if (cleanFlags.length > 1) {
            // Multiple flags (short and long): '(-v --verbose)'{-v,--verbose}'[description]'
            const short = cleanFlags[0];
            const long = cleanFlags[1];
            return `'(${short} ${long})'{${short},${long}}'[${desc}]'`;
          } else {
            // Single flag: '--flag[description]'
            return `'${cleanFlags[0]}[${desc}]'`;
          }
        })
        .join(" \\\n        ");

      return options
        ? `    ${cmd.name()})
      _arguments \\
        ${options}
      ;;`
        : "";
    })
    .filter(Boolean)
    .join("\n");

  const completionScript = `
# pushwork completion for zsh
_pushwork() {
  local -a commands
  commands=(${commands})
  
  _arguments -C \\
    '1: :->command' \\
    '*::arg:->args'
  
  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
${commandCases}
      esac
      ;;
  esac
}

compdef _pushwork pushwork
    `.trim();

  console.log(completionScript);
});

// Helper to validate and extract sync server options
function validateSyncServer(
  syncServerOpt: string[] | undefined
): [string | undefined, StorageId | undefined] {
  if (!syncServerOpt) {
    return [undefined, undefined];
  }

  if (syncServerOpt.length < 2) {
    console.error(
      chalk.red("Error: --sync-server requires both URL and storage ID")
    );
    process.exit(1);
  }

  const [syncServer, syncServerStorageId] = syncServerOpt;
  return [syncServer, syncServerStorageId as StorageId];
}

process.on("unhandledRejection", (error) => {
  console.log(chalk.bgRed.white(" ERROR "));
  if (error instanceof Error && error.stack) {
    console.log(chalk.red(error.stack));
  } else {
    console.error(chalk.red(error));
  }
  process.exit(1);
});

// Configure help colors using Commander v13's built-in color support
program
  .configureHelp({
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
  })
  .addHelpText(
    "after",
    chalk.dim(
      '\nEnable tab completion by adding this to your ~/.zshrc:\neval "$(pushwork completion)"'
    )
  );

program.parseAsync();
