#!/usr/bin/env node
import "./log.js"; // sets up DEBUG=true → DEBUG=* before anything else
import { Command } from "@commander-js/extra-typings";
import * as path from "path";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import {
	clone,
	createDraft,
	currentDraft,
	cutWorkdir,
	deleteDraft,
	diff,
	draftUrl,
	drafts,
	heads,
	init,
	merge,
	pasteSnarf,
	renameDraft,
	save,
	showSnarfs,
	status,
	switchDraft,
	sync,
	url,
	yeet,
	yoink,
	type DraftRef,
} from "./pushwork.js";
import type { DraftSummary } from "./drafts/actions.js";
import { log } from "./log.js";
import { out } from "./output.js";
import {
	isClosedStorageError,
	isTransportError,
	legacyUrl,
	setAmrepoErrorSink,
	subductionUrl,
	type SyncSnapshot,
} from "./repo.js";
import { formatVersions } from "./version.js";
import { importGit } from "./import-git.js";
import { migrate, versionLabel } from "./migrations.js";

const dlog = log("cli");

const JSON_DOCS_HELP =
	'Store new .json files whose "@patchwork".type isn\'t "file" as Automerge JSON documents instead of text';

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
	if (isTransportError(err) || isClosedStorageError(err)) {
		dlog("suppressed uncaught teardown error: %s", err.message);
		return;
	}
	out.error(err);
	out.exit(1);
});
process.on("unhandledRejection", (reason) => {
	if (isTransportError(reason) || isClosedStorageError(reason)) {
		dlog(
			"suppressed teardown rejection: %s",
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
	const full = `${tag}: ${message}${detail ? ` ${detail}` : ""}`;
	// The dispatch-after-shutdown race also arrives here as a Rust-side ERROR
	// log; keep it out of the UI like the rejection handlers do.
	if (isClosedStorageError(full)) {
		dlog("suppressed teardown storage error log: %s", full);
		return;
	}
	out.warn(full);
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

const draftLabel = (draft: DraftRef) => (draft.url ? `draft ${draft.name}` : draft.name);

async function switchAction(ref: string | undefined, create: string | undefined): Promise<void> {
	const cwd = process.cwd();
	if (create !== undefined) {
		const { draft } = await createDraft(cwd, { name: create, start: ref, switchTo: true });
		out.log(`Switched to a new ${draftLabel(draft)}`);
		return;
	}
	if (!ref) throw new Error("name a draft to switch to, or main");
	const { draft, alreadyOn } = await switchDraft(cwd, ref);
	out.log(`${alreadyOn ? "Already on" : "Switched to"} ${draftLabel(draft)}`);
}

/** `git branch`-style: one line per draft, `*` on the checked-out one. */
function printDrafts(
	listing: { root: string; current: string | null; drafts: DraftSummary[] },
	tree: boolean,
): void {
	const mark = (url: string | null) => (url === listing.current ? "*" : " ");
	if (out.isPorcelain) {
		out.log(`${mark(null)}\tmain\t${listing.root}\t`);
		for (const d of listing.drafts) out.log(`${mark(d.url)}\t${d.name}\t${d.url}\t${d.parent ?? ""}`);
		return;
	}
	const prefixes = tree ? treePrefixes(listing.drafts) : listing.drafts.map(() => "");
	const lines = [`${mark(null)} main`];
	listing.drafts.forEach((d, i) => lines.push(`${mark(d.url)} ${prefixes[i]}${d.name}`));
	out.log(lines.join("\n"));
}

// The connector drawn before each draft so the list reads as the fork tree,
// under main.
function treePrefixes(list: DraftSummary[]): string[] {
	const byUrl = new Map(list.map((d) => [d.url, d]));
	const isLast = new Map(
		list.map((d, i) => [d.url, !list.slice(i + 1).some((e) => e.parent === d.parent)]),
	);
	return list.map((d) => {
		let lead = "";
		for (let p = d.parent; p; p = byUrl.get(p)?.parent ?? null) {
			lead = (isLast.get(p) ? "   " : "│  ") + lead;
		}
		return lead + (isLast.get(d.url) ? "└─ " : "├─ ");
	});
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
	.option("--json-docs", JSON_DOCS_HELP)
	.action(async (dir, opts) => {
		dlog("init dir=%s opts=%o", dir, opts);
		const backend = backendOf(opts);
		const root = path.resolve(dir);
		out.intro("pushwork init");
		out.task("Connecting to sync server");
		const info = await init(
			{
				dir: root,
				backend,
				shape: opts.shape,
				artifactDirectories: opts.artifactDir,
				jsonDocuments: opts.jsonDocs,
			},
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
	.command("import-git")
	.description(
		"Import a git repository into Patchwork: main from a branch's history, a draft for every other branch",
	)
	.argument("[dir]", "The git repository", ".")
	.option("--main <branch>", "The branch to make main (default: the checked-out branch)")
	.option(
		"--branch <name>",
		"A branch to make a draft of (default: every other local branch). Repeatable.",
		collect,
		undefined as string[] | undefined,
	)
	.option("--depth <n>", "Replay at most this many of main's commits", "200")
	.option("--history", "Replay all of those commits, not only from the oldest a draft starts at")
	.option("--github <owner/repo>", "The GitHub repository strand syncs with (default: origin's)")
	.option("--no-github", "Don't connect main to a GitHub repository")
	.option(
		"--artifact-dir <dir>",
		"Directory whose text is stored atomically (default: dist). Repeatable.",
		collect,
		undefined as string[] | undefined,
	)
	.option("--offline", "Don't publish to the sync server (keeps the storage, see --storage)")
	.option("--storage <dir>", "Keep the automerge storage here instead of a temporary directory")
	.option("--no-sub", "Use the legacy WebSocket sync backend instead of Subduction")
	.option("--legacy", "Alias for --no-sub")
	.action(async (dir, opts) => {
		dlog("import-git dir=%s opts=%o", dir, opts);
		const backend = backendOf(opts);
		const depth = Number(opts.depth);
		if (!Number.isInteger(depth) || depth < 1) throw new Error("--depth takes a whole number above 0");
		let github: { owner: string; repo: string } | null | undefined;
		if (opts.github === false) github = null;
		else if (typeof opts.github === "string") {
			const [owner, repo, ...rest] = opts.github.split("/");
			if (!owner || !repo || rest.length) throw new Error("--github takes owner/repo");
			github = { owner, repo };
		}
		out.intro("pushwork import-git");
		const info = await importGit(
			{
				gitDir: path.resolve(dir),
				backend,
				main: opts.main,
				branches: opts.branch,
				depth,
				history: Boolean(opts.history),
				github,
				artifactDirectories: opts.artifactDir,
				online: !opts.offline,
				storageDir: opts.storage ? path.resolve(opts.storage) : undefined,
			},
			report,
			warn,
		);
		out.done();
		out.obj({
			Main: `${info.main.branch}: ${info.main.files} files, ${info.main.commits} ${info.main.commits === 1 ? "commit" : "commits"} replayed`,
			Drafts: info.drafts.length
				? info.drafts.map((d) => `${d.branch} (${d.changed} changed)`).join(", ")
				: "none",
			GitHub: info.github ? `${info.github.owner}/${info.github.repo}` : "not connected",
			...(info.storageKept ? { Storage: info.storageDir } : {}),
		});
		for (const skip of info.skipped) out.warn(`Skipped ${skip.branch}: ${skip.reason}`);
		if (info.sync && !info.sync.every((s) => s.synced)) {
			out.warn("Not everything was confirmed by the sync server; the storage was kept.");
		}
		out.block("IMPORTED", info.url);
		out.outro("Open the URL in strand");
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
	.option("--json-docs", JSON_DOCS_HELP)
	.option("-b, --draft <draft>", "Check out this draft (name, url, or main) instead of main")
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
				jsonDocuments: opts.jsonDocs,
				draft: opts.draft,
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
	.option("--draft [draft]", "Print a draft's URL instead (default: the checked-out draft), for `clone <root> --draft <url>`")
	.action(async (opts) => {
		dlog("url cwd=%s opts=%o", process.cwd(), opts);
		if (opts.draft === undefined) {
			out.log(await url(process.cwd()));
			return;
		}
		out.log(await draftUrl(process.cwd(), opts.draft === true ? undefined : opts.draft));
	});

program
	.command("yoink")
	.description("Pull a single file doc by URL and write it to disk")
	.argument("<url>", "automerge: URL of a UnixFileEntry doc, or a JSON document")
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
	.argument("<url>", "automerge: URL of the UnixFileEntry doc or JSON document to overwrite")
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
		const { diff: d, draft } = await status(process.cwd());
		const total = d.added.length + d.modified.length + d.deleted.length;
		if (out.isPorcelain) {
			for (const p of d.modified) out.log(`modified\t${p}`);
			for (const p of d.added) out.log(`added\t${p}`);
			for (const p of d.deleted) out.log(`deleted\t${p}`);
			return;
		}
		const on = `On ${draftLabel(draft)}`;
		if (total === 0) {
			out.log(`${on}\nnothing to save, working tree clean`);
			return;
		}
		const lines = [on, "Changes:"];
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
	.command("draft")
	.description(
		"List drafts, or create, rename (-m) or delete (-d/-D) one. Like `git branch`, for drafts.",
	)
	.argument("[name]", "Draft to create (or, with -m/-d, the draft to act on)")
	.argument("[start]", "Draft to fork it off (default: the checked-out draft); with -m, the new name")
	.option("-m, --move", "Rename: `draft -m <new>` renames the checked-out draft, `draft -m <old> <new>` another")
	.option("-d, --delete", "Delete a draft that has no unmerged changes")
	.option("-D", "Delete a draft even if it has unmerged changes")
	.option("--show-current", "Print the checked-out draft's name")
	.option("--tree", "List drafts as the tree they were forked in")
	.action(async (name, start, opts) => {
		const cwd = process.cwd();
		if (opts.showCurrent) {
			out.log((await currentDraft(cwd)).name);
			return;
		}
		if (opts.move) {
			if (!name) throw new Error("usage: pushwork draft -m [<old>] <new>");
			const result =
				start === undefined ? await renameDraft(cwd, name) : await renameDraft(cwd, start, name);
			out.success(`renamed draft ${result.from} to ${result.to}`);
			return;
		}
		if (opts.delete || opts.D) {
			if (!name) throw new Error("usage: pushwork draft -d <draft>");
			const deleted = await deleteDraft(cwd, name, { force: Boolean(opts.D) });
			out.success(`deleted draft ${deleted.name}`);
			return;
		}
		if (name) {
			const { draft } = await createDraft(cwd, { name, start });
			out.success(`created draft ${draft.name}`);
			return;
		}
		printDrafts(await drafts(cwd), Boolean(opts.tree));
	});

program
	.command("switch")
	.description("Switch to a draft (or main) and update the working tree to match")
	.argument("[draft]", "Draft to switch to: a name, url, or main (with -c, the draft to fork off)")
	.option("-c, --create <name>", "Create a draft and switch to it")
	.action(async (ref, opts) => {
		await switchAction(ref, opts.create);
	});

program
	.command("checkout")
	.description("Alias for switch; -b creates a draft and switches to it")
	.argument("[draft]", "Draft to switch to: a name, url, or main (with -b, the draft to fork off)")
	.option("-b <name>", "Create a draft and switch to it")
	.action(async (ref, opts) => {
		await switchAction(ref, opts.b);
	});

program
	.command("merge")
	.description("Merge the checked-out draft into the draft it was forked off, and switch to that")
	.action(async () => {
		const result = await merge(process.cwd());
		out.success(
			`merged draft ${result.from} into ${result.into.name} (${plural(result.merged, "doc")})`,
		);
		out.log(`Switched to ${draftLabel(result.into)}`);
	});

program
	.parseAsync(process.argv)
	.then(() => out.exit(0))
	.catch((err) => {
		out.error(err instanceof Error ? err.message : String(err));
		out.exit(1);
	});
