#!/usr/bin/env node
import "./log.js"; // sets up DEBUG=true → DEBUG=* before anything else
import { Command } from "@commander-js/extra-typings";
import * as path from "path";
import {
	clone,
	createBranch,
	currentBranch,
	cutWorkdir,
	diff,
	init,
	listBranches,
	mergeBranch,
	pasteStash,
	previewMerge,
	save,
	showStashes,
	status,
	switchBranch,
	sync,
	url,
} from "./pushwork.js";
import { log } from "./log.js";

const dlog = log("cli");

const collect = (value: string, prev: string[] | undefined) =>
	(prev ?? []).concat(value);

const program = new Command()
	.name("pushwork")
	.description("Bidirectional directory synchronization using Automerge CRDTs");

program
	.command("init")
	.description("Initialize pushwork in a directory")
	.argument("[dir]", "Directory to initialize", ".")
	.option("--sub", "Use subduction backend")
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
	.option("--no-branches", "Skip wrapping the root doc in a branches doc")
	.action(async (dir, opts) => {
		dlog("init dir=%s opts=%o", dir, opts);
		const u = await init({
			dir: path.resolve(dir),
			backend: opts.sub ? "subduction" : "legacy",
			shape: opts.shape,
			artifactDirectories: opts.artifactDir,
			branches: opts.branches,
		});
		process.stderr.write(`initialized ${u}\n`);
	});

program
	.command("clone")
	.description("Clone an automerge URL into a directory")
	.argument("<url>", "automerge: URL")
	.argument("[dir]", "Target directory", ".")
	.option("--sub", "Use subduction backend")
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
	.option("--branch <name>", "Branch to track when cloning a branches doc")
	.action(async (u, dir, opts) => {
		dlog("clone url=%s dir=%s opts=%o", u, dir, opts);
		await clone({
			url: u,
			dir: path.resolve(dir),
			backend: opts.sub ? "subduction" : "legacy",
			shape: opts.shape,
			artifactDirectories: opts.artifactDir,
			branch: opts.branch,
		});
		process.stderr.write(`cloned into ${path.resolve(dir)}\n`);
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
	.action(async () => {
		dlog("sync cwd=%s", process.cwd());
		await sync(process.cwd());
		process.stderr.write("synced\n");
	});

program
	.command("save")
	.alias("commit")
	.description("Commit local changes to the current branch without contacting the sync server")
	.action(async () => {
		dlog("save cwd=%s", process.cwd());
		await save(process.cwd());
		process.stderr.write("saved\n");
	});

program
	.command("status")
	.description("Show current branch and changes against it")
	.action(async () => {
		const { branch, diff: d } = await status(process.cwd());
		const lines: string[] = [];
		if (branch) lines.push(`On branch ${branch}`);
		else lines.push("(no branches)");
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
	.description("Show textual diffs of local changes against the current branch")
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
	.command("branch")
	.description("With no arg: print the current branch. With <name>: create a new branch from the current one (offline).")
	.argument("[name]", "Name of the new branch")
	.action(async (name) => {
		if (!name) {
			const cur = await currentBranch(process.cwd());
			process.stdout.write((cur ?? "(none)") + "\n");
			return;
		}
		const newUrl = await createBranch(process.cwd(), name);
		process.stderr.write(`created branch ${name} → ${newUrl}\n`);
	});

program
	.command("switch")
	.description("Switch to a branch (offline). With no name: list branches.")
	.argument("[name]", "Name of the branch to switch to")
	.action(async (name) => {
		if (!name) {
			const { current, names } = await listBranches(process.cwd());
			for (const n of names) {
				process.stdout.write(`${n === current ? "* " : "  "}${n}\n`);
			}
			return;
		}
		await switchBranch(process.cwd(), name);
		process.stderr.write(`switched to ${name}\n`);
	});

program
	.command("merge")
	.description("Apply changes from <source> branch onto the current branch (offline)")
	.argument("<source>", "Branch to merge into the current one")
	.option("--dry", "Preview the merge without applying")
	.action(async (source, opts) => {
		if (opts.dry) {
			const preview = await previewMerge(process.cwd(), source);
			const lines: string[] = [];
			lines.push(`Merging ${preview.source} into ${preview.target} (preview)`);
			if (preview.entries.length === 0) {
				lines.push("(no changes)");
				process.stdout.write(lines.join("\n") + "\n");
				return;
			}
			const { createPatch } = await import("diff");
			const td = new TextDecoder("utf-8", { fatal: false });
			for (const e of preview.entries) {
				const before = e.before ? td.decode(e.before) : "";
				const after = td.decode(e.after);
				const tag = e.kind === "added" ? "added" : "merged";
				lines.push(`  ${tag}:     ${e.path}`);
				lines.push(createPatch(e.path, before, after, "", ""));
			}
			process.stdout.write(lines.join("\n") + "\n");
			return;
		}
		const report = await mergeBranch(process.cwd(), source);
		const lines: string[] = [];
		lines.push(`Merging ${report.source} into ${report.target}`);
		if (report.merged.length === 0 && report.added.length === 0) {
			lines.push("(no changes)");
		} else {
			for (const p of report.merged) lines.push(`  merged:     ${p}`);
			for (const p of report.added) lines.push(`  added:      ${p}`);
		}
		process.stdout.write(lines.join("\n") + "\n");
	});

program
	.command("cut")
	.description("Stash working-tree changes against the current branch and reset the tree to clean (offline)")
	.argument("[name]", "Optional name for the stash entry")
	.action(async (name) => {
		const result = await cutWorkdir(process.cwd(), { name });
		process.stderr.write(`cut #${result.id}: ${result.entries} entr${result.entries === 1 ? "y" : "ies"}\n`);
	});

program
	.command("paste")
	.description("Re-apply a stashed set of changes; default is the most recent (offline)")
	.argument("[id-or-name]", "Stash id or name")
	.action(async (selector) => {
		const result = await pasteStash(process.cwd(), selector);
		process.stderr.write(
			`pasted #${result.id}${result.name ? ` (${result.name})` : ""}: ${result.entries} entr${result.entries === 1 ? "y" : "ies"}\n`,
		);
	});

program
	.command("cuts")
	.description("List stashed change sets (newest first)")
	.action(async () => {
		const stashes = await showStashes(process.cwd());
		if (stashes.length === 0) {
			process.stdout.write("(no stashes)\n");
			return;
		}
		for (const s of stashes) {
			const ts = new Date(s.createdAt).toISOString();
			const label = s.name ? `"${s.name}"` : "";
			const branch = s.branch ? ` on ${s.branch}` : "";
			process.stdout.write(
				`#${s.id}${label ? " " + label : ""}${branch}  ${s.entries.length} entr${s.entries.length === 1 ? "y" : "ies"}  ${ts}\n`,
			);
		}
	});

program
	.command("branches")
	.description("List branches")
	.action(async () => {
		const { current, names } = await listBranches(process.cwd());
		for (const n of names) {
			process.stdout.write(`${n === current ? "* " : "  "}${n}\n`);
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
