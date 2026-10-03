#!/usr/bin/env node
import "./log.js"; // sets up DEBUG=true → DEBUG=* before anything else
import { Command } from "@commander-js/extra-typings";
import * as path from "path";
import {
	clone,
	cutWorkdir,
	diff,
	heads,
	init,
	pasteSnarf,
	plural,
	save,
	showSnarfs,
	status,
	sync,
	url,
	yeet,
	yoink,
	type RepoSummary,
	type SyncSummary,
} from "./pushwork.js";
import type { SyncReport } from "./docs.js";
import type { AutomergeUrl } from "./url.js";
import { log } from "./log.js";
import { out } from "./output.js";
import { formatVersions } from "./version.js";

const dlog = log("cli");

const collect = (value: string, prev: string[] | undefined) =>
	(prev ?? []).concat(value);

const report = (phase: string) => out.step(phase);

// Warnings raised mid-operation are flushed after the result line, because
// printing one clears the active spinner and would swallow the result.
const warnings: string[] = [];
const warn = (message: string) => {
	warnings.push(message);
};
const flushWarnings = () => {
	for (const w of warnings) out.warn(w);
	warnings.length = 0;
};

const fmtHeads = (heads: string[]) => (heads.length ? heads.join(" ") : "(none)");

function verdict(sync: SyncReport): { state: string; detail: string } {
	if (!sync.online) return { state: "OFFLINE", detail: sync.error ?? "" };
	if (sync.unsynced.length === 0) return { state: "SYNCED", detail: "" };
	return {
		state: "PENDING",
		detail: `${plural(sync.unsynced.length, "document")} not confirmed by the server`,
	};
}

function reportSync(sync: SyncSummary): void {
	const { state, detail } = verdict(sync);
	if (out.isPorcelain) {
		out.log(`sync\t${state.toLowerCase()}`);
		if (sync.error) out.log(`error\t${sync.error}`);
		out.log(`connect\t${sync.connectMs ?? ""}`);
		out.log(`root\t${sync.url}\t${sync.heads.join(" ")}`);
		for (const u of sync.unsynced) out.log(`unsynced\t${u}`);
		return;
	}
	out.block(state, detail);
	out.obj({ "root doc": sync.url, "root heads": fmtHeads(sync.heads) });
}

const summaryRows = (root: string, info: RepoSummary, filesLabel: string) => ({
	Path: root,
	Files: `${info.files} ${filesLabel}`,
});

async function pickStrategyInteractively(info: {
	url: AutomergeUrl;
	viewCode: () => string;
}): Promise<boolean> {
	out.info(
		`This repo's root doc has no standard @patchwork.type but declares a custom strategy: ${info.url}`,
	);
	out.warn(
		"Running it executes code written by the document's author. Inspect it first.",
	);
	for (;;) {
		const choice = await out.select<"run" | "view" | "abort">(
			"Download and run this strategy?",
			[
				{ value: "run", label: "Run it", hint: "decode this repo with the strategy" },
				{ value: "view", label: "View the code first" },
				{ value: "abort", label: "Abort the clone" },
			],
		);
		if (choice === "run") return true;
		if (choice === "abort") return false;
		out.log("\n----- .pushworkStrategy -----");
		out.log(info.viewCode().replace(/\n?$/, "\n") + "----- end -----\n");
	}
}

const program = new Command()
	.name("pushwork")
	.description("Bidirectional directory synchronization using Automerge CRDTs")
	.version(formatVersions(), "-v, --version", "Print version info and exit")
	.option(
		"--porcelain",
		"Machine-readable output: tab-separated lines, no spinners/colors/prompts",
	)
	.option("-q, --quiet", "Suppress progress; show only results and errors")
	.option("--silent", "Suppress all output except errors (check exit code)")
	.hook("preAction", (thisCommand) => {
		const opts = thisCommand.opts();
		out.configure({
			porcelain: Boolean(opts.porcelain),
			verbosity: opts.silent ? "silent" : opts.quiet ? "quiet" : "normal",
		});
	});

program
	.command("version")
	.description("Print pushwork and Automerge package versions")
	.action(() => {
		out.log(formatVersions());
	});

program
	.command("init")
	.description("Initialize pushwork in a directory")
	.argument("[dir]", "Directory to initialize", ".")
	.option("--offline", "Don't contact the sync server")
	.option("--server <url>", "Sync server to use for this repo")
	.option("--publish", "Publish with keyhive: anyone can read and clone, only you can write")
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
		const root = path.resolve(dir);
		out.intro("pushwork init");
		out.task(opts.offline ? "Initializing" : "Connecting to sync server");
		const info = await init(
			{
				dir: root,
				shape: opts.shape,
				artifactDirectories: opts.artifactDir,
				online: !opts.offline,
				server: opts.server,
				publish: opts.publish,
			},
			report,
			warn,
		);
		out.done(); // complete the final phase line before the summary
		out.obj(summaryRows(root, info, "tracked"));
		out.block("INITIALIZED", info.url);
		reportSync(info.sync);
		out.outro("Done");
		flushWarnings();
	});

program
	.command("clone")
	.description("Clone an automerge URL into a directory")
	.argument("<url>", "automerge: URL")
	.argument("<dir>", "Target directory")
	.option("--server <url>", "Sync server to use for this repo")
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
		const root = path.resolve(dir);
		out.intro("pushwork clone");
		out.task("Connecting to sync server");
		const info = await clone(
			{
				url: u,
				dir: root,
				shape: opts.shape,
				artifactDirectories: opts.artifactDir,
				server: opts.server,
				onStrategyDoc: pickStrategyInteractively,
			},
			report,
		);
		out.done(); // complete the final phase line before the summary
		out.obj(summaryRows(root, info, "downloaded"));
		out.block("CLONED", info.url);
		reportSync(info.sync);
		out.outro("Done");
	});

program
	.command("url")
	.description("Print the automerge URL of this pushwork repo")
	.action(async () => {
		out.log(await url(process.cwd()));
	});

program
	.command("yoink")
	.description("Pull a single file doc by URL and write it to disk")
	.argument("<url>", "automerge: URL of a UnixFileEntry doc")
	.argument("[path]", "Where to write it (defaults to the doc's own name)")
	.option("--server <url>", "Sync server to fetch from")
	.action(async (u, dest, opts) => {
		dlog("yoink url=%s dest=%s", u, dest);
		out.task("Yoinking");
		const result = await yoink(process.cwd(), u, dest, opts.server);
		out.done(`yoinked ${result.path} (${plural(result.bytes, "byte")})`);
	});

program
	.command("yeet")
	.description("Push a single file from disk into a file doc by URL")
	.argument("<path>", "File to read")
	.argument("<url>", "automerge: URL of the UnixFileEntry doc to overwrite")
	.option("--server <url>", "Sync server to push to")
	.action(async (src, u, opts) => {
		dlog("yeet src=%s url=%s", src, u);
		out.task("Yeeting");
		const result = await yeet(process.cwd(), src, u, opts.server);
		out.done(`yeeted ${result.path} → ${result.url} (${plural(result.bytes, "byte")})`);
		const { state, detail } = verdict(result.sync);
		if (state !== "SYNCED") out.warn(`${state}${detail ? `: ${detail}` : ""}`);
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
		out.intro(opts.nuclear ? "pushwork sync --nuclear" : "pushwork sync");
		out.task("Connecting to sync server");
		const summary = await sync(process.cwd(), { nuclear: opts.nuclear }, report, warn);
		out.done(); // complete the final phase line before the summary
		reportSync(summary);
		out.outro("Done");
		flushWarnings();
	});

program
	.command("save")
	.alias("commit")
	.description("Commit local changes without contacting the sync server")
	.action(async () => {
		dlog("save cwd=%s", process.cwd());
		out.task("Saving");
		await save(process.cwd(), undefined, warn);
		out.done("saved");
		flushWarnings();
	});

program
	.command("status")
	.description("Show changes against the saved state")
	.action(async () => {
		const { diff: d } = await status(process.cwd());
		const total = d.added.length + d.modified.length + d.deleted.length;
		if (out.isPorcelain) {
			for (const p of d.modified) out.log(`modified\t${p}`);
			for (const p of d.added) out.log(`added\t${p}`);
			for (const p of d.deleted) out.log(`deleted\t${p}`);
			return;
		}
		if (total === 0) {
			out.log("nothing to save, working tree clean");
			return;
		}
		const lines = ["Changes:"];
		for (const p of d.modified) lines.push(`  modified:   ${p}`);
		for (const p of d.added) lines.push(`  added:      ${p}`);
		for (const p of d.deleted) lines.push(`  deleted:    ${p}`);
		out.log(lines.join("\n"));
	});

program
	.command("diff")
	.description("Show textual diffs of local changes against the saved state")
	.argument("[path]", "Limit to a specific path")
	.action(async (limitPath) => {
		const entries = await diff(process.cwd(), limitPath);
		if (entries.length === 0) {
			out.log("(no changes)");
			return;
		}
		const { createPatch } = await import("diff");
		const td = new TextDecoder("utf-8", { fatal: false });
		const chunks: string[] = [];
		for (const e of entries) {
			const before = e.before ? td.decode(e.before) : "";
			const after = e.after ? td.decode(e.after) : "";
			const header =
				e.kind === "added"
					? `+++ ${e.path}`
					: e.kind === "deleted"
						? `--- ${e.path}`
						: `*** ${e.path}`;
			chunks.push(header);
			chunks.push(createPatch(e.path, before, after, "", ""));
		}
		out.log(chunks.join("\n"));
	});

program
	.command("heads")
	.description("Print Automerge heads for the root folder and every file doc (offline)")
	.argument("[pathspec]", "Limit to a path or path prefix (e.g. \"src\" or \"src/foo.ts\")")
	.action(async (pathspec) => {
		const entries = await heads(process.cwd(), pathspec);
		if (entries.length === 0) {
			out.log("(no matching docs)");
			return;
		}
		out.log(
			entries
				.map((e) => `${e.path}\t${e.url}\t${e.heads.join(" ")}`)
				.join("\n"),
		);
	});

program
	.command("cut")
	.description("Snarf working-tree changes and reset the tree to the saved state (offline)")
	.argument("[name]", "Optional name for the snarf entry")
	.action(async (name) => {
		const result = await cutWorkdir(process.cwd(), { name });
		out.success(`cut #${result.id}: ${plural(result.entries, "entry", "entries")}`);
	});

program
	.command("paste")
	.description("Re-apply a snarfed set of changes; default is the most recent (offline)")
	.argument("[id-or-name]", "Snarf id or name")
	.action(async (selector) => {
		const result = await pasteSnarf(process.cwd(), selector);
		const label = result.name ? ` (${result.name})` : "";
		out.success(
			`pasted #${result.id}${label}: ${plural(result.entries, "entry", "entries")}`,
		);
	});

program
	.command("snarfs")
	.alias("clipboard")
	.description("List snarfed change sets (newest first)")
	.action(async () => {
		const snarfs = await showSnarfs(process.cwd());
		if (snarfs.length === 0) {
			out.log("(no snarfs)");
			return;
		}
		out.arr(
			snarfs.map((s) => {
				const ts = new Date(s.createdAt).toISOString();
				const name = s.name ? ` "${s.name}"` : "";
				return `#${s.id}${name}  ${plural(s.entries.length, "entry", "entries")}  ${ts}`;
			}),
		);
	});

program
	.parseAsync(process.argv)
	.then(() => out.exit(0))
	.catch((err) => {
		out.error(err instanceof Error ? err.message : String(err));
		out.exit(1);
	});
