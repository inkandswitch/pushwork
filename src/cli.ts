#!/usr/bin/env node
import "./log.js"; // sets up DEBUG=true → DEBUG=* before anything else
import { Command } from "@commander-js/extra-typings";
import * as path from "path";
import * as readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import {
	clone,
	cutWorkdir,
	diff,
	heads,
	init,
	pasteSnarf,
	save,
	showSnarfs,
	status,
	sync,
	url,
} from "./pushwork.js";
import { log } from "./log.js";
import { formatVersions } from "./version.js";
import { migrate, versionLabel } from "./migrations.js";

const dlog = log("cli");

const collect = (value: string, prev: string[] | undefined) =>
	(prev ?? []).concat(value);

const backendOf = (opts: { sub?: boolean; legacy?: boolean }) =>
	opts.legacy || opts.sub === false ? "legacy" : "subduction";

async function pickBranchInteractively(info: {
	title?: string;
	branches: { name: string; url: AutomergeUrl }[];
}): Promise<AutomergeUrl> {
	const titlePart = info.title ? ` (${info.title})` : "";
	process.stderr.write(
		`\nThis URL points to a legacy "branches" doc${titlePart}.\n`,
	);
	process.stderr.write(
		`Branches aren't supported in pushwork — pick a branch to clone its folder directly:\n\n`,
	);
	for (let i = 0; i < info.branches.length; i++) {
		process.stderr.write(`  ${i + 1}) ${info.branches[i].name}\n`);
	}
	process.stderr.write("\n");

	const rl = readline.createInterface({ input, output });
	try {
		while (true) {
			const answer = (
				await rl.question(`Pick a branch [1-${info.branches.length}]: `)
			).trim();
			const n = Number.parseInt(answer, 10);
			if (Number.isFinite(n) && n >= 1 && n <= info.branches.length) {
				return info.branches[n - 1].url;
			}
			const byName = info.branches.find((b) => b.name === answer);
			if (byName) return byName.url;
			process.stderr.write(`invalid selection: ${answer}\n`);
		}
	} finally {
		rl.close();
	}
}

// Read a single keypress (git-style prompts). Falls back to a line read when
// stdin isn't a TTY (e.g. piped input), returning the first character.
async function readChar(): Promise<string> {
	if (!input.isTTY || typeof input.setRawMode !== "function") {
		const rl = readline.createInterface({ input, output });
		try {
			const line = (await rl.question("")).trim();
			return line.slice(0, 1) || "\n";
		} finally {
			rl.close();
		}
	}
	return new Promise<string>((resolve) => {
		input.setRawMode(true);
		input.resume();
		input.once("data", (buf: Buffer) => {
			input.setRawMode(false);
			input.pause();
			resolve(buf.toString("utf8"));
		});
	});
}

async function pickStrategyInteractively(info: {
	url: AutomergeUrl;
	viewCode: () => string;
}): Promise<boolean> {
	process.stderr.write(
		`\nThis repo's root doc has no standard @patchwork.type, but it declares a custom strategy:\n`,
	);
	process.stderr.write(`  .pushworkStrategy → ${info.url}\n\n`);
	process.stderr.write(
		`Pushwork can download this strategy module and run it to decode the repo.\n`,
	);
	process.stderr.write(
		`Running it executes code written by the document's author. Inspect it first.\n\n`,
	);

	while (true) {
		process.stderr.write(
			`Download and run this strategy? [y]es, [n]o, [v]iew code, [?] help: `,
		);
		const raw = await readChar();
		const code = raw.charCodeAt(0);
		if (code === 3) {
			// Ctrl-C
			process.stderr.write("\naborted\n");
			process.exit(130);
		}
		const ch = raw.toLowerCase();
		process.stderr.write(/\S/.test(ch) ? ch + "\n" : "\n");
		if (ch === "y") return true;
		if (ch === "n" || code === 27) return false; // n or Esc
		if (ch === "v") {
			process.stderr.write("\n----- .pushworkStrategy -----\n");
			process.stderr.write(info.viewCode().replace(/\n?$/, "\n"));
			process.stderr.write("----- end -----\n\n");
			continue;
		}
		process.stderr.write(
			`  y - download the strategy module and run it to decode this repo\n` +
				`  n - abort the clone (Esc also works)\n` +
				`  v - print the strategy source, then ask again\n`,
		);
	}
}

const program = new Command()
	.name("pushwork")
	.description("Bidirectional directory synchronization using Automerge CRDTs")
	.version(formatVersions(), "-v, --version", "Print version info and exit");

program
	.command("version")
	.description("Print pushwork and Automerge package versions")
	.action(() => {
		process.stdout.write(formatVersions() + "\n");
	});

program
	.command("init")
	.description("Initialize pushwork in a directory")
	.argument("[dir]", "Directory to initialize", ".")
	.option("--no-sub", "Use the legacy WebSocket sync backend instead of Subduction")
	.option("--legacy", "Alias for --no-sub")
	.option(
		"--shape <shape>",
		"Document shape: vfs, patchwork-folder, or path to a custom shape module",
		"vfs",
	)
	.option(
		"--artifact-dir <dir>",
		"Directory whose contents are stored as ImmutableString and pinned with heads in the root doc. Repeatable.",
		collect,
		undefined as string[] | undefined,
	)
	.action(async (dir, opts) => {
		dlog("init dir=%s opts=%o", dir, opts);
		const u = await init({
			dir: path.resolve(dir),
			backend: backendOf(opts),
			shape: opts.shape,
			artifactDirectories: opts.artifactDir,
		});
		process.stderr.write(`initialized ${u}\n`);
	});

program
	.command("clone")
	.description("Clone an automerge URL into a directory")
	.argument("<url>", "automerge: URL")
	.argument("<dir>", "Target directory")
	.option("--no-sub", "Use the legacy WebSocket sync backend instead of Subduction")
	.option("--legacy", "Alias for --no-sub")
	.option(
		"--shape <shape>",
		"Fallback shape if the root doc's @patchwork.type isn't recognized (directory→vfs, folder→patchwork-folder) and no .pushworkStrategy is run: vfs, patchwork-folder, or path to a custom shape module",
		"vfs",
	)
	.option(
		"--artifact-dir <dir>",
		"Directory whose contents are stored as ImmutableString and pinned with heads in the root doc. Repeatable.",
		collect,
		undefined as string[] | undefined,
	)
	.action(async (u, dir, opts) => {
		dlog("clone url=%s dir=%s opts=%o", u, dir, opts);
		await clone({
			url: u,
			dir: path.resolve(dir),
			backend: backendOf(opts),
			shape: opts.shape,
			artifactDirectories: opts.artifactDir,
			onBranchesDoc: pickBranchInteractively,
			onStrategyDoc: pickStrategyInteractively,
		});
		process.stderr.write(`cloned into ${path.resolve(dir)}\n`);
	});

program
	.command("migrate")
	.description(
		"Upgrade an old .pushwork/config.json (including an original pushwork \"main\" repo) to the current format",
	)
	.argument("[dir]", "Directory to migrate", ".")
	.action(async (dir) => {
		const root = path.resolve(dir);
		dlog("migrate root=%s", root);
		const result = await migrate(root);
		if (result.steps.length === 0) {
			process.stderr.write(`already up to date (version ${result.to})\n`);
			return;
		}
		process.stderr.write(
			`migrated ${versionLabel(result.from)} → ${result.to}\n`,
		);
		for (const s of result.steps) process.stderr.write(`  ${s}\n`);
	});

program
	.command("url")
	.description("Print the automerge URL of this pushwork repo")
	.action(async () => {
		dlog("url cwd=%s", process.cwd());
		const u = await url(process.cwd());
		process.stdout.write(u + "\n");
	});

program
	.command("sync")
	.description("Sync local changes with peers")
	.option(
		"--nuclear",
		"Re-create every doc (file, folder) with a fresh URL before syncing. Stops referencing the old URLs from this repo.",
	)
	.action(async (opts) => {
		dlog("sync cwd=%s opts=%o", process.cwd(), opts);
		await sync(process.cwd(), { nuclear: opts.nuclear });
		process.stderr.write(opts.nuclear ? "nuclear synced\n" : "synced\n");
	});

program
	.command("save")
	.alias("commit")
	.description("Commit local changes without contacting the sync server")
	.action(async () => {
		dlog("save cwd=%s", process.cwd());
		await save(process.cwd());
		process.stderr.write("saved\n");
	});

program
	.command("status")
	.description("Show changes against the saved state")
	.action(async () => {
		const { diff: d } = await status(process.cwd());
		const lines: string[] = [];
		const total = d.added.length + d.modified.length + d.deleted.length;
		if (total === 0) {
			lines.push("nothing to save, working tree clean");
		} else {
			lines.push("Changes:");
			for (const p of d.modified) lines.push(`  modified:   ${p}`);
			for (const p of d.added) lines.push(`  added:      ${p}`);
			for (const p of d.deleted) lines.push(`  deleted:    ${p}`);
		}
		process.stdout.write(lines.join("\n") + "\n");
	});

program
	.command("diff")
	.description("Show textual diffs of local changes against the saved state")
	.argument("[path]", "Limit to a specific path")
	.action(async (limitPath) => {
		const entries = await diff(process.cwd(), limitPath);
		if (entries.length === 0) {
			process.stdout.write("(no changes)\n");
			return;
		}
		const { createPatch } = await import("diff");
		const td = new TextDecoder("utf-8", { fatal: false });
		for (const e of entries) {
			const before = e.before ? td.decode(e.before) : "";
			const after = e.after ? td.decode(e.after) : "";
			const header =
				e.kind === "added" ? `+++ ${e.path}` :
				e.kind === "deleted" ? `--- ${e.path}` :
				`*** ${e.path}`;
			process.stdout.write(header + "\n");
			process.stdout.write(createPatch(e.path, before, after, "", "") + "\n");
		}
	});

program
	.command("heads")
	.description("Print Automerge heads for the root folder and every file doc (offline)")
	.argument("[pathspec]", "Limit to a path or path prefix (e.g. \"src\" or \"src/foo.ts\")")
	.action(async (pathspec) => {
		const entries = await heads(process.cwd(), pathspec);
		if (entries.length === 0) {
			process.stdout.write("(no matching docs)\n");
			return;
		}
		for (const e of entries) {
			process.stdout.write(`${e.path}\t${e.url}\t${e.heads.join(" ")}\n`);
		}
	});

program
	.command("cut")
	.description("Snarf working-tree changes and reset the tree to the saved state (offline)")
	.argument("[name]", "Optional name for the snarf entry")
	.action(async (name) => {
		const result = await cutWorkdir(process.cwd(), { name });
		process.stderr.write(`cut #${result.id}: ${result.entries} entr${result.entries === 1 ? "y" : "ies"}\n`);
	});

program
	.command("paste")
	.description("Re-apply a snarfed set of changes; default is the most recent (offline)")
	.argument("[id-or-name]", "Snarf id or name")
	.action(async (selector) => {
		const result = await pasteSnarf(process.cwd(), selector);
		process.stderr.write(
			`pasted #${result.id}${result.name ? ` (${result.name})` : ""}: ${result.entries} entr${result.entries === 1 ? "y" : "ies"}\n`,
		);
	});

program
	.command("snarfs")
	.alias("clipboard")
	.description("List snarfed change sets (newest first)")
	.action(async () => {
		const snarfs = await showSnarfs(process.cwd());
		if (snarfs.length === 0) {
			process.stdout.write("(no snarfs)\n");
			return;
		}
		for (const s of snarfs) {
			const ts = new Date(s.createdAt).toISOString();
			const label = s.name ? `"${s.name}"` : "";
			process.stdout.write(
				`#${s.id}${label ? " " + label : ""}  ${s.entries.length} entr${s.entries.length === 1 ? "y" : "ies"}  ${ts}\n`,
			);
		}
	});

program
	.parseAsync(process.argv)
	.then(() => process.exit(0))
	.catch((err) => {
		process.stderr.write(
			`pushwork: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	});
