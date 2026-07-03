#!/usr/bin/env node
import "./log.js"; // sets up DEBUG=true → DEBUG=* before anything else
import { Command } from "@commander-js/extra-typings";
import * as path from "path";
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
	yeet,
	yoink,
} from "./pushwork.js";
import { log } from "./log.js";
import { out } from "./output.js";
import {
	isTransportError,
	legacyUrl,
	setAmrepoErrorSink,
	subductionUrl,
	type SyncSnapshot,
} from "./repo.js";
import { formatVersions } from "./version.js";
import { migrate, versionLabel } from "./migrations.js";

const dlog = log("cli");

const priorWarn = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (w) => {
	if (w.name === "TimeoutNegativeWarning") return;
	if (priorWarn.length > 0) for (const l of priorWarn) l.call(process, w);
	else process.stderr.write(`(node:${process.pid}) ${w.name}: ${w.message}\n`);
});

// A dropped connection can surface as an async error with no local listener;
// suppress those transport blips (Node would otherwise dump a stack trace or
// exit), and let genuine faults through.
process.on("uncaughtException", (err) => {
	if (isTransportError(err)) {
		dlog("suppressed uncaught transport error: %s", err.message);
		return;
	}
	out.error(err);
	out.exit(1);
});
process.on("unhandledRejection", (reason) => {
	if (isTransportError(reason)) {
		dlog(
			"suppressed transport rejection: %s",
			reason instanceof Error ? reason.message : String(reason),
		);
		return;
	}
	out.error(reason instanceof Error ? reason : String(reason));
	out.exit(1);
});

// am-repo logs are silent by default (see openRepo); surface genuine `error`s in
// the UI. Main process only — workers keep logs out of the parent's output.
setAmrepoErrorSink((namespace, message, ...args) => {
	const tag = namespace.replace(/^automerge-repo:/, "");
	const detail = args
		.map((a) => (a instanceof Error ? a.message : String(a)))
		.join(" ");
	out.warn(`${tag}: ${message}${detail ? ` ${detail}` : ""}`);
});

const collect = (value: string, prev: string[] | undefined) =>
	(prev ?? []).concat(value);

const backendOf = (opts: { sub?: boolean; legacy?: boolean }) =>
	opts.legacy || opts.sub === false ? "legacy" : "subduction";

// Like `backendOf` but returns undefined when no flag is given, so callers can
// fall back to the repo's config (or their own default) instead of forcing
// subduction.
const backendOverrideOf = (opts: { sub?: boolean; legacy?: boolean }) =>
	opts.legacy || opts.sub === false ? ("legacy" as const) : undefined;

const endpointOf = (backend: "legacy" | "subduction") =>
	backend === "legacy" ? legacyUrl() : subductionUrl();

const report = (phase: string) => out.step(phase);

// Warnings raised mid-operation are buffered and flushed *after* the result
// line: emitting one immediately clears the active spinner, which would
// otherwise swallow the command's completion ("saved", the summary, etc.).
const warnings: string[] = [];
const warn = (message: string) => {
	warnings.push(message);
};
const flushWarnings = () => {
	for (const w of warnings) out.warn(w);
	warnings.length = 0;
};

const plural = (n: number, one: string, many = one + "s") =>
	`${n} ${n === 1 ? one : many}`;

const fmtHeads = (heads: string[]) => (heads.length ? heads.join(" ") : "(none)");

/**
 * Render where the root doc stands relative to the sync server: our own
 * Automerge heads and the heads the server last advertised. When synced, we
 * hold every commit the server has (see waitForServerSync) — the two sets are
 * the same history even though the server's Subduction sedimentree heads need
 * not be string-identical to our Automerge frontier.
 */
function reportSync(sync: SyncSnapshot | undefined): void {
	if (!sync) return;
	if (out.isPorcelain) {
		out.log(
			`sync\t${sync.synced ? "synced" : sync.pending ? "pending" : sync.connected ? "behind" : "offline"}`,
		);
		out.log(`connect\t${sync.connectMs ?? ""}`);
		out.log(`root\t${sync.url}\t${sync.localHeads.join(" ")}`);
		out.log(`server\t${sync.serverPeerId ?? ""}\t${sync.serverHeads.join(" ")}`);
		return;
	}
	out.block(
		sync.synced
			? "SYNCED"
			: sync.pending
				? "PENDING"
				: sync.connected
					? "NOT SYNCED"
					: "OFFLINE",
	);
	out.obj({
		"root doc": sync.url,
		"sync server": sync.serverPeerId ?? "(not connected)",
		"root heads": fmtHeads(sync.localHeads),
		"server heads": fmtHeads(sync.serverHeads),
	});
}

async function pickBranchInteractively(info: {
	title?: string;
	branches: { name: string; url: AutomergeUrl }[];
}): Promise<AutomergeUrl> {
	const titlePart = info.title ? ` (${info.title})` : "";
	out.info(
		`This URL is a legacy "branches" doc${titlePart}; branches aren't supported. Pick one to clone its folder directly.`,
	);
	return out.select(
		"Branch to clone",
		info.branches.map((b) => ({ value: b.url, label: b.name })),
	);
}

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
		const backend = backendOf(opts);
		const root = path.resolve(dir);
		out.intro("pushwork init");
		out.task("Connecting to sync server");
		const info = await init(
			{ dir: root, backend, shape: opts.shape, artifactDirectories: opts.artifactDir },
			report,
			warn,
		);
		out.done(); // complete the final phase line before the summary
		out.obj({
			Path: root,
			Files: `${info.files} tracked`,
			Backend: backend,
			Sync: endpointOf(backend),
		});
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
		const backend = backendOf(opts);
		const root = path.resolve(dir);
		out.intro("pushwork clone");
		out.task("Connecting to sync server");
		const info = await clone(
			{
				url: u,
				dir: root,
				backend,
				shape: opts.shape,
				artifactDirectories: opts.artifactDir,
				onBranchesDoc: pickBranchInteractively,
				onStrategyDoc: pickStrategyInteractively,
			},
			report,
		);
		out.done(); // complete the final phase line before the summary
		out.obj({
			Path: root,
			Files: `${info.files} downloaded`,
			Backend: backend,
			Sync: endpointOf(backend),
		});
		out.block("CLONED", info.url);
		reportSync(info.sync);
		out.outro("Done");
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
			out.success(`already up to date (version ${result.to})`);
			return;
		}
		out.success(`migrated ${versionLabel(result.from)} → ${result.to}`);
		out.arr(result.steps);
	});

program
	.command("url")
	.description("Print the automerge URL of this pushwork repo")
	.action(async () => {
		dlog("url cwd=%s", process.cwd());
		out.log(await url(process.cwd()));
	});

program
	.command("yoink")
	.description("Pull a single file doc by URL and write it to disk")
	.argument("<url>", "automerge: URL of a UnixFileEntry doc")
	.argument("[path]", "Where to write it (defaults to the doc's own name)")
	.option("--no-sub", "Use the legacy WebSocket sync backend instead of Subduction")
	.action(async (u, dest, opts) => {
		dlog("yoink url=%s dest=%s", u, dest);
		out.task("Yoinking");
		const result = await yoink(process.cwd(), u, dest, backendOverrideOf(opts));
		out.done(`yoinked ${result.path} (${plural(result.bytes, "byte")})`);
	});

program
	.command("yeet")
	.description("Push a single file from disk into a file doc by URL")
	.argument("<path>", "File to read")
	.argument("<url>", "automerge: URL of the UnixFileEntry doc to overwrite")
	.option("--no-sub", "Use the legacy WebSocket sync backend instead of Subduction")
	.action(async (src, u, opts) => {
		dlog("yeet src=%s url=%s", src, u);
		out.task("Yeeting");
		const result = await yeet(process.cwd(), src, u, backendOverrideOf(opts));
		out.done(`yeeted ${result.path} → ${result.url} (${plural(result.bytes, "byte")})`);
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
		const snapshot = await sync(process.cwd(), { nuclear: opts.nuclear }, report, warn);
		out.done(); // complete the final phase line before the summary
		reportSync(snapshot);
		out.outro(opts.nuclear ? "nuclear synced" : "synced");
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
