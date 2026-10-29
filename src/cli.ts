#!/usr/bin/env node
import "./log.js"; // sets up DEBUG=true → DEBUG=* before anything else
import { Argument, Command, Option } from "@commander-js/extra-typings";
import * as path from "path";
import {
	clone,
	merge,
	shapeInstall,
	listShapes,
	removeShape,
	ACCESS_LEVELS,
	keyhiveInfo,
	setKeyhiveServer,
	setPublicAccess,
	setContactAccess,
	repoAccess,
	addContact,
	listContacts,
	removeContact,
	checkAccess,
	addPublicApp,
	listPublicApps,
	newPublicApp,
	removePublicApp,
	migrate,
	track,
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
import { KEYHIVE_VERSIONS } from "./keyhive/common.js";
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
	.option("--sync-server <url>", "Sync server for document data, saved in the repo's config")
	.option("--keyhive", "Protect the repo with keyhive (only you can read it, unless --public-access says otherwise)")
	.option("--keyhive-server <server>", "Keyhive server for this repo: a built-in name (keyhive, subduction) or a ws(s):// url")
	.option("--keyhive-card <card>", "The keyhive server's contact card, needed with a url (keyline asks the server for it): a built-in name, JSON or base64, an http(s) url or a file")
	.addOption(
		new Option("--keyhive-version <version>", "Keyhive version for this keyhive repo: automerge-repo-keyhive 0.5 or 0.6, or keyline (default 0.6)").choices(
			KEYHIVE_VERSIONS,
		),
	)
	.addOption(
		new Option("--public-access <level>", "With --keyhive: what anyone may do with the repo").choices(ACCESS_LEVELS),
	)
	.option("--public-app <name>", "With --keyhive and keyline: the app whose users count as anyone (default patchwork)")
	.addOption(
		new Option("--server-access <level>", "With --keyhive: what the sync server may do (default relay)").choices(
			ACCESS_LEVELS,
		),
	)
	.option(
		"--shape <shape>",
		"Document shape: vfs, patchwork-folder, an installed shape's name, or a path to a shape module",
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
		if (!opts.keyhive && (opts.publicAccess || opts.serverAccess || opts.publicApp)) {
			throw new Error("--public-access, --public-app and --server-access only apply with --keyhive");
		}
		if (opts.publicApp && !opts.publicAccess) throw new Error("--public-app needs --public-access");
		out.intro("pushwork init");
		out.task(opts.offline ? "Initializing" : "Connecting to sync server");
		const info = await init(
			{
				dir: root,
				shape: opts.shape,
				artifactDirectories: opts.artifactDir,
				online: !opts.offline,
				syncServer: opts.syncServer,
				keyhive: opts.keyhive
					? { publicAccess: opts.publicAccess, serverAccess: opts.serverAccess, publicApp: opts.publicApp }
					: undefined,
				keyhiveServer: opts.keyhiveServer,
				keyhiveCard: opts.keyhiveCard,
				keyhiveVersion: opts.keyhiveVersion,
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

const attachCommand = (name: string, description: string, dirArg: string) =>
	program
		.command(name)
		.description(description)
		.argument("<url>", "automerge: URL")
		.argument(dirArg, "Target directory", dirArg === "[dir]" ? "." : undefined)
		.option("--sync-server <url>", "Sync server for document data, saved in the repo's config")
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
		.option("--keyhive-server <server>", "For a keyhive repo: its keyhive server, a built-in name (keyhive, subduction) or a ws(s):// url")
		.option("--keyhive-card <card>", "The keyhive server's contact card, needed with a url (keyline asks the server for it): a built-in name, JSON or base64, an http(s) url or a file")
		.addOption(
			new Option("--keyhive-version <version>", "For a keyhive repo: its keyhive version (default 0.6)").choices(
				KEYHIVE_VERSIONS,
			),
		);

const attachOpts = (
	u: string,
	root: string,
	opts: {
		shape: string;
		artifactDir?: string[];
		syncServer?: string;
		keyhiveServer?: string;
		keyhiveCard?: string;
		keyhiveVersion?: (typeof KEYHIVE_VERSIONS)[number];
	},
) => ({
	url: u,
	dir: root,
	shape: opts.shape,
	artifactDirectories: opts.artifactDir,
	syncServer: opts.syncServer,
	keyhiveServer: opts.keyhiveServer,
	keyhiveCard: opts.keyhiveCard,
	keyhiveVersion: opts.keyhiveVersion,
	onStrategyDoc: pickStrategyInteractively,
});

attachCommand("clone", "Clone an automerge URL into a directory", "<dir>").action(
	async (u, dir, opts) => {
		dlog("clone url=%s dir=%s opts=%o", u, dir, opts);
		const root = path.resolve(dir);
		out.intro("pushwork clone");
		out.task("Connecting to sync server");
		const info = await clone(attachOpts(u, root, opts), report);
		out.done(); // complete the final phase line before the summary
		out.obj(summaryRows(root, info, "downloaded"));
		out.block("CLONED", info.url);
		reportSync(info.sync);
		out.outro("Done");
	},
);

attachCommand(
	"track",
	"Follow an automerge URL from an existing directory, leaving its files as they are",
	"[dir]",
).action(async (u, dir, opts) => {
	dlog("track url=%s dir=%s opts=%o", u, dir, opts);
	const root = path.resolve(dir);
	out.intro("pushwork track");
	out.task("Connecting to sync server");
	const info = await track(attachOpts(u, root, opts), report);
	out.done();
	out.obj(summaryRows(root, info, "tracked"));
	out.block("TRACKING", info.url);
	out.info("the next sync pushes local differences, including files missing here as deletions");
	out.outro("Done");
});

attachCommand(
	"merge",
	"Join an existing directory with an automerge URL, keeping files from both (local wins)",
	"[dir]",
).action(async (u, dir, opts) => {
	dlog("merge url=%s dir=%s opts=%o", u, dir, opts);
	const root = path.resolve(dir);
	out.intro("pushwork merge");
	out.task("Connecting to sync server");
	const info = await merge(attachOpts(u, root, opts), report, warn);
	out.done();
	out.obj(summaryRows(root, info, "in the url"));
	out.block("MERGED", info.url);
	reportSync(info.sync);
	out.outro("Done");
	flushWarnings();
});

program
	.command("migrate")
	.description("Upgrade a pushwork 2 repo in place (the old .pushwork is kept in .pushwork/pushwork_migration_backup_safe_to_delete)")
	.option("--sync-server <url>", "Sync server for document data, saved in the repo's config")
	.action(async (opts) => {
		const root = process.cwd();
		out.intro("pushwork migrate");
		out.task("Connecting to sync server");
		const info = await migrate(root, { syncServer: opts.syncServer }, report);
		out.done();
		out.obj(summaryRows(root, info, "tracked"));
		const { diff: d } = await status(root);
		const total = d.added.length + d.modified.length + d.deleted.length + d.renamed.length;
		if (total) {
			out.warn(
				`${plural(total, "file")} here differ from the server; the next sync pushes them. Check \`pushwork status\` first.`,
			);
		}
		out.outro("Done");
	});

const keyhive = program
	.command("keyhive")
	.description("Show the keyhive server keyhive repos sync through, and your contact card")
	.addHelpText(
		"after",
		`
To get your contact card from patchwork (with keyhive on), run this in its devtools console;
it copies the card's JSON to the clipboard:

  copy((await (hive.keyhive.getExistingContactCard ?? hive.keyhive.contactCard).call(hive.keyhive)).toJson())

Then, here: pushwork keyhive contacts add <name> '<card json>'`,
	)
	.addOption(
		new Option("--keyhive-version <version>", "Which keyhive identity's card to show (default 0.6)").choices(KEYHIVE_VERSIONS),
	)
	.action(async opts => {
		const info = await keyhiveInfo(opts.keyhiveVersion);
		out.obj({
			Keyhive: `automerge-repo-keyhive ${info.version}`,
			Server: info.serverName ? `${info.server} (${info.serverName})` : info.server,
			"Server card": info.cardName ? `${info.cardName} (built in)` : "custom",
			"Server peer": info.serverPeer,
			"Your id": info.id,
			"Built in": Object.entries(info.builtIn)
				.map(([name, url]) => `${name} → ${url}`)
				.join(", "),
		});
		out.info("Your contact card:");
		out.log(info.me);
	});

keyhive
	.command("server")
	.description("Set the keyhive sync server for new keyhive repos on this machine")
	.argument("<server>", "A built-in name (keyhive, subduction) or a ws(s):// url")
	.argument(
		"[card]",
		"The server's contact card, for a url (a keyline server is asked for its own): a built-in name, JSON or base64, an http(s) url or a file",
	)
	.action(async (server, card) => {
		await setKeyhiveServer(server, card);
		out.log(`keyhive server set to ${server}`);
	});

keyhive
	.command("check")
	.description("Check what you, or an app's public user, can do with a keyhive repo: pull it, and read it")
	.argument("<url>", "The repo's automerge: URL")
	.option("--app <name>", "Check as this app's public user instead of as you (keyline; see `keyhive apps`)")
	.option("--keyhive-server <server>", "The repo's keyhive server: a built-in name or a ws(s):// url")
	.option("--keyhive-card <card>", "The keyhive server's contact card, for a url (a keyline server is asked for its own)")
	.addOption(new Option("--keyhive-version <version>", "The repo's keyhive version (default 0.6)").choices(KEYHIVE_VERSIONS))
	.action(async (url, _opts, cmd) => {
		const check = await checkAccess(url as `automerge:${string}`, cmd.optsWithGlobals());
		out.obj({
			as: check.as,
			pulled: `${check.pulled} blob${check.pulled === 1 ? "" : "s"} of the root doc`,
			verdict: check.readable ? "can read" : check.pulled ? "can pull but not read (relay)" : "can't pull: no access",
		});
	});

const GRANT_LEVELS = ["relay", "read", "edit", "admin", "none"] as const;

keyhive
	.command("public")
	.description("Set what anyone with this keyhive repo's URL may do")
	.addArgument(
		new Argument("<level>", "relay (store and forward), read, edit, admin, or none to take public access away").choices(
			GRANT_LEVELS,
		),
	)
	.option("--app <name>", "For a keyline repo: the app whose users count as anyone (default patchwork; see `keyhive apps`)")
	.action(async (level, opts) => {
		await setPublicAccess(process.cwd(), level, opts.app);
		const who = opts.app ? `${opts.app}'s users` : "anyone with the URL";
		out.log(level === "none" ? `public access removed${opts.app ? ` for ${opts.app}` : ""}` : `${who} can now ${level}`);
	});

keyhive
	.command("access")
	.description("Show who can access this keyhive repo, or set a contact's access")
	.argument("[contact]", "A contact's name (see `pushwork keyhive contacts`)")
	.addArgument(
		new Argument("[level]", "relay, read, edit, admin, or none to revoke their access").choices(GRANT_LEVELS),
	)
	.action(async (contact, level) => {
		if (contact && !level) throw new Error("give a level: relay, read, edit, admin or none");
		if (contact && level) {
			await setContactAccess(process.cwd(), contact, level);
			out.log(level === "none" ? `${contact}'s access revoked` : `${contact} can now ${level}`);
			return;
		}
		const members = await repoAccess(process.cwd());
		out.obj(
			Object.fromEntries(
				members.map(m => [
					m.public ? (m.app ? `anyone (${m.app})` : "anyone") : m.you ? "you" : m.server ? "keyhive server" : (m.name ?? m.id),
					m.access,
				]),
			),
		);
	});

const apps = keyhive
	.command("apps")
	.description("Apps whose users a keyline repo can be public to, each through its own public pair");

apps
	.command("ls")
	.description("List apps with public pairs: built in, and added on this machine")
	.action(async () => {
		const all = await listPublicApps();
		out.obj(
			Object.fromEntries(
				all.map(a => [a.name, `${a.added ? (a.builtIn ? "added (overrides built-in)" : "added") : "built in"}: reader ${a.reader}, fetcher ${a.fetcher}`]),
			),
		);
	});

apps
	.command("add")
	.description("Save another app's public pair under a name, or update one with --replace")
	.argument("<name>", "What to call the app")
	.argument("<pair>", "Its public pair: JSON, an http(s) url or a file (as `keyhive apps new` prints it)")
	.option("--replace", "Update an app that already has a pair (repos made public with the old one stay readable only with it)")
	.action(async (name, pair, opts) => {
		const app = await addPublicApp(name, pair, { replace: opts.replace });
		out.log(`saved ${app.name} (reader ${app.reader}, fetcher ${app.fetcher})`);
	});

apps
	.command("new")
	.description("Make a public pair for a new app, save it, and print it (JSON) for the app to ship")
	.argument("<name>", "What to call the app")
	.option("--replace", "Replace the pair an app already has")
	.action(async (name, opts) => {
		// only the pair goes to stdout, so it can be redirected to a file to ship
		const { principals } = await newPublicApp(name, { replace: opts.replace });
		out.log(JSON.stringify(principals, null, 2));
	});

apps
	.command("rm")
	.description("Forget an added app's pair (a built-in app goes back to the pair pushwork ships)")
	.argument("<name>", "The app's name")
	.action(async name => {
		await removePublicApp(name);
		out.log(`removed ${name}`);
	});

const contacts = keyhive.command("contacts").description("Keyhive contact cards, by name, for granting access");

contacts
	.command("add")
	.description("Save someone's contact card under a name")
	.argument("<name>", "What to call them")
	.argument("<card>", "Their contact card: JSON, an http(s) url or a file")
	.action(async (name, card) => {
		const contact = await addContact(name, card);
		out.log(`saved ${contact.name} (${contact.id})`);
	});

contacts
	.command("me")
	.description("Print your own contact card, for someone to add and grant you access with")
	.addOption(
		new Option("--keyhive-version <version>", "Which keyhive identity's card (default 0.6)").choices(KEYHIVE_VERSIONS),
	)
	.action(async (_opts, cmd) => {
		// `keyhive` has its own --keyhive-version, which commander gives the flag to
		const { keyhiveVersion } = cmd.optsWithGlobals();
		// only the card goes to stdout, so it can be captured
		out.log((await keyhiveInfo(keyhiveVersion)).me);
	});

contacts
	.command("ls")
	.description("List saved contacts")
	.action(async () => {
		const all = await listContacts();
		if (!all.length) {
			out.log("no contacts; add one with `pushwork keyhive contacts add <name> <card>`");
			return;
		}
		out.obj(Object.fromEntries(all.map(c => [c.name, c.id])));
	});

contacts
	.command("rm")
	.description("Forget a saved contact (their access to repos is unchanged)")
	.argument("<name>", "The contact's name")
	.action(async name => {
		await removeContact(name);
		out.log(`removed ${name}`);
	});

const shape = program.command("shape").description("Manage installed document shapes");

shape
	.command("install")
	.description("Install a shape so `--shape <name>` can use it")
	.argument("<source>", "A shape module: a file, an http(s) url, or an automerge: url of a file doc")
	.option("--name <name>", "Name to install it as (default: the source's file name)")
	.option("--sync-server <url>", "Sync server to fetch an automerge: url from")
	.action(async (source, opts) => {
		const { name, path: file } = await shapeInstall(process.cwd(), source, {
			name: opts.name,
			syncServer: opts.syncServer,
		});
		out.log(`installed shape ${name} (${file})`);
	});

shape
	.command("list")
	.description("List installed shapes")
	.action(async () => {
		for (const name of await listShapes()) out.log(name);
	});

shape
	.command("remove")
	.description("Remove an installed shape")
	.argument("<name>")
	.action(async (name) => {
		await removeShape(name);
		out.log(`removed shape ${name}`);
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
	.option("--sync-server <url>", "Sync server to use (default: the repo's, else the default server)")
	.action(async (u, dest, opts) => {
		dlog("yoink url=%s dest=%s", u, dest);
		out.task("Yoinking");
		const result = await yoink(process.cwd(), u, dest, opts.syncServer);
		out.done(`yoinked ${result.path} (${plural(result.bytes, "byte")})`);
	});

program
	.command("yeet")
	.description("Push a single file from disk into a file doc by URL")
	.argument("<path>", "File to read")
	.argument("<url>", "automerge: URL of the UnixFileEntry doc to overwrite")
	.option("--sync-server <url>", "Sync server to use (default: the repo's, else the default server)")
	.action(async (src, u, opts) => {
		dlog("yeet src=%s url=%s", src, u);
		out.task("Yeeting");
		const result = await yeet(process.cwd(), src, u, opts.syncServer);
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
		const total = d.added.length + d.modified.length + d.deleted.length + d.renamed.length;
		if (out.isPorcelain) {
			for (const p of d.modified) out.log(`modified\t${p}`);
			for (const p of d.added) out.log(`added\t${p}`);
			for (const p of d.deleted) out.log(`deleted\t${p}`);
			for (const r of d.renamed) out.log(`renamed\t${r.from}\t${r.to}`);
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
		for (const r of d.renamed) lines.push(`  renamed:    ${r.from} -> ${r.to}`);
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
		const { createPatch, createTwoFilesPatch } = await import("diff");
		const td = new TextDecoder("utf-8", { fatal: false });
		const chunks: string[] = [];
		for (const e of entries) {
			const before = e.before ? td.decode(e.before) : "";
			const after = e.after ? td.decode(e.after) : "";
			if (e.kind === "renamed") {
				chunks.push(`*** ${e.from} -> ${e.path}`);
				chunks.push(createTwoFilesPatch(e.from!, e.path, before, after, "", ""));
				continue;
			}
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
