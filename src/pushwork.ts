import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as Automerge from "@automerge/automerge";
import {
	isValidAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
} from "@automerge/automerge-repo";
import {
	CONFIG_VERSION,
	configExists,
	pushworkDir,
	readConfig,
	storageDir,
	writeConfig,
	type Backend,
	type PushworkConfig,
} from "./config.js";
import { loadIgnore } from "./ignore.js";
import { baseOf, readBases, writeBases, type Bases } from "./bases.js";
import {
	ATTRIBUTES_FILE,
	attributesTreeOf,
	type AttributesTree,
	type Datatype,
} from "./attributes.js";
import { byteEq, walkDir, writeFileAtomic, type FileTree } from "./fs-tree.js";
import { log } from "./log.js";
import {
	openRepo,
	safeShutdown,
	waitForConnection,
	waitForSync,
	waitForServerSync,
	type Connection,
	type SyncSnapshot,
} from "./repo.js";
import {
	appendSnarf,
	decodeBytes,
	encodeBytes,
	listSnarfs,
	takeSnarf,
	type Snarf,
	type SnarfEntry,
} from "./snarf.js";
import {
	applyFileEntry,
	contentToBytes,
	documentValueOf,
	flattenLeaves,
	formatJson,
	isFileEntryDoc,
	isInArtifactDir,
	jsonDocumentOf,
	jsonEquals,
	jsonLinkType,
	jsonValueOf,
	leafContent,
	leafMatchesDisk,
	makeFileEntry,
	mutateFileEntry,
	newDir,
	normalizeArtifactDir,
	parseJsonObject,
	patchJson,
	patchworkFolderShape,
	pinUrl,
	readFileEntry,
	resolveShape,
	setFileAt,
	stripHeads,
	urlHeads,
	vfsShape,
	withMeta,
	type JsonObject,
	type LeafContent,
	type Shape,
	type UnixFileEntry,
	type VfsNode,
} from "./shapes/index.js";
import { loadCustomShape } from "./shapes/custom.js";
import * as draftOps from "./drafts/actions.js";
import type { DraftSummary } from "./drafts/actions.js";
import { canonicalUrl } from "./drafts/clones.js";
import { treeMembers } from "./drafts/tree.js";
import {
	isDraftDoc,
	type CloneEntry,
	type DraftDoc,
	type HasOverlays,
	type MergeDoc,
} from "./drafts/types.js";
import { DraftView, repairCloneConflicts } from "./drafts/view.js";

const dlog = log("pushwork");

const DEFAULT_ARTIFACT_DIRECTORIES = ["dist"];

/** Called at phase boundaries of long operations so the CLI can show progress. */
export type Reporter = (phase: string) => void;
const noReport: Reporter = () => {};

/** Surfaces a non-fatal warning (e.g. a settings override) to the user. */
export type Warn = (message: string) => void;
const noWarn: Warn = () => {};

/** Decides whether a repo-relative posix path is an artifact (its text content
 *  stored as an atomic ImmutableString rather than a merge-able CRDT text). */
type IsArtifact = (posixPath: string) => boolean;

/** The Patchwork datatype a `.pushworkattributes` rule assigns to a
 *  repo-relative posix path, if any. */
type DatatypeOf = (posixPath: string) => Datatype | undefined;

/** A leaf as recorded at its pinned link: the merge base for the next sync. */
export type StoredLeaf = LeafContent & { url: AutomergeUrl };

/**
 * Build the artifact classifier from the working tree's attributes. Its
 * `.pushworkattributes` files (in any directory, each scoped to its own
 * subtree) travel with the repo content, so their `artifact` rules take
 * precedence over the local `.pushwork/config.json` `artifactDirectories`.
 * When attributes files are present *and* the local config also lists
 * directories, we warn — the local list is being ignored in favor of the
 * ones the repo carries.
 */
function artifactClassifier(
	attrs: AttributesTree,
	configDirs: readonly string[],
	warn: Warn = noWarn,
): IsArtifact {
	if (attrs.hasArtifactRules) {
		if (configDirs.length > 0) {
			warn(
				`${ATTRIBUTES_FILE} defines artifact paths and overrides ` +
					`artifactDirectories [${configDirs.join(", ")}] from .pushwork/config.json`,
			);
		}
		dlog("artifact source: %s files", ATTRIBUTES_FILE);
		return (p) => attrs.isArtifact(p);
	}
	dlog("artifact source: config artifactDirectories %o", configDirs);
	return (p) => isInArtifactDir(p, configDirs);
}

export const datatypeClassifier = (attrs: AttributesTree): DatatypeOf => (p) =>
	attrs.datatypeOf(p);

const diskDatatypes = (fsFiles: FileTree): DatatypeOf =>
	datatypeClassifier(attributesTreeOf(fsFiles));

/** Result of init/clone: the root doc URL, how many files it tracks, and — when
 * run online — how it stands relative to the sync server (see {@link SyncSnapshot}). */
export type RepoSummary = {
	url: AutomergeUrl;
	files: number;
	sync?: SyncSnapshot;
};

export type InitOpts = {
	dir: string;
	backend: Backend;
	shape: string;
	artifactDirectories?: readonly string[];
	jsonDocuments?: boolean; // default: false
	online?: boolean; // default: true
};

export type CloneOpts = {
	url: string;
	dir: string;
	backend: Backend;
	shape: string;
	artifactDirectories?: readonly string[];
	jsonDocuments?: boolean; // default: false
	online?: boolean; // default: true
	// The draft to check out: `main`, a draft's name, its url, or a prefix of
	// its id.
	draft?: string;
	// If the URL turns out to be a legacy "branches" doc, this callback is
	// invoked with the available branch entries and must return the URL to
	// clone instead. If absent, clone throws.
	onBranchesDoc?: (info: {
		title?: string;
		branches: { name: string; url: AutomergeUrl }[];
	}) => Promise<AutomergeUrl> | AutomergeUrl;
	// If the root doc has no recognized @patchwork.type but declares a
	// `.pushworkStrategy` automerge URL, this callback is invoked to decide
	// whether to download that strategy module and run it as a custom shape.
	// `viewCode` returns the strategy source so the user can inspect it before
	// approving. Returning false (or omitting the callback) skips the strategy
	// and falls back to `opts.shape`.
	onStrategyDoc?: (info: {
		url: AutomergeUrl;
		viewCode: () => string;
	}) => Promise<boolean> | boolean;
};

export type Diff = {
	added: string[];
	modified: string[];
	deleted: string[];
};

export async function init(
	opts: InitOpts,
	report: Reporter = noReport,
	warn: Warn = noWarn,
): Promise<RepoSummary> {
	const root = path.resolve(opts.dir);
	const online = opts.online ?? true;
	dlog("init root=%s backend=%s shape=%s online=%s", root, opts.backend, opts.shape, online);
	if (await configExists(root)) {
		throw new Error(`pushwork already initialized at ${root}`);
	}
	const ig = await loadIgnore(root);
	report("Reading working tree");
	const fsFiles = await walkDir(root, ig);
	dlog("init walked %d files", fsFiles.size);

	// `.pushworkattributes` files already in the working tree are
	// authoritative; keep config.json's artifactDirectories empty so it never
	// fights the repo-carried attributes (and never triggers an override
	// warning later).
	const attrs = attributesTreeOf(fsFiles);
	if (attrs.hasArtifactRules && opts.artifactDirectories?.length) {
		warn(
			`${ATTRIBUTES_FILE} defines artifact paths; ignoring --artifact-dir ` +
				`[${opts.artifactDirectories.join(", ")}]`,
		);
	}
	const artifactDirs = attrs.hasArtifactRules
		? []
		: normalizeDirs(opts.artifactDirectories ?? DEFAULT_ARTIFACT_DIRECTORIES);
	const isArtifactPath: IsArtifact = attrs.hasArtifactRules
		? (p) => attrs.isArtifact(p)
		: (p) => isInArtifactDir(p, artifactDirs);
	dlog("init artifactDirs=%o attributes=%s", artifactDirs, attrs.hasArtifactRules);
	await fs.mkdir(pushworkDir(root), { recursive: true });

	const repo = await openRepo(opts.backend, storageDir(root), { offline: !online });
	// Start measuring the connection now so the local encode overlaps it.
	const connWait = online ? waitForConnection(repo, opts.backend) : undefined;
	try {
		const shape = await resolveShape(opts.shape);
		const title = path.basename(root) || undefined;
		report(`Encoding ${fsFiles.size} ${fsFiles.size === 1 ? "file" : "files"}`);
		const jsonDocuments = opts.jsonDocuments ?? false;
		const { tree, bases } = await pushFiles(
			repo,
			fsFiles,
			undefined,
			isArtifactPath,
			datatypeClassifier(attrs),
			jsonDocuments,
			warn,
		);
		const folderUrl = await shape.encode({
			repo,
			tree,
			title,
		});
		dlog("init encoded folder=%s title=%s", folderUrl, title);
		const folderHandle = await repo.find<unknown>(folderUrl);

		let sync: SyncSnapshot | undefined;
		if (online) {
			report(
				`Publishing ${fsFiles.size} ${fsFiles.size === 1 ? "file" : "files"} to the sync server`,
			);
			stampLastSyncAt(folderHandle);
			sync = await waitForServerSync(repo, folderHandle, opts.backend, {
				idleMs: 1500,
				maxMs: 15000,
			});
		}

		await writeConfig(root, {
			version: CONFIG_VERSION,
			rootUrl: folderUrl,
			backend: opts.backend,
			shape: opts.shape,
			artifactDirectories: artifactDirs,
			jsonDocuments,
			draft: null,
		});
		await writeBases(root, bases);
		await attachConnectMs(sync, connWait);
		dlog("init complete: rootUrl=%s files=%d synced=%s", folderUrl, fsFiles.size, sync?.synced);
		return { url: folderUrl, files: fsFiles.size, sync };
	} finally {
		await safeShutdown(repo);
	}
}

export async function clone(
	opts: CloneOpts,
	report: Reporter = noReport,
): Promise<RepoSummary> {
	if (!isValidAutomergeUrl(opts.url)) {
		throw new Error(`invalid automerge URL: ${opts.url}`);
	}
	const root = path.resolve(opts.dir);
	dlog("clone url=%s root=%s backend=%s shape=%s", opts.url, root, opts.backend, opts.shape);
	await fs.mkdir(root, { recursive: true });
	if (await configExists(root)) {
		throw new Error(`pushwork already initialized at ${root}`);
	}
	await fs.mkdir(pushworkDir(root), { recursive: true });

	const online = opts.online ?? true;
	const repo = await openRepo(opts.backend, storageDir(root), { offline: !online });
	const connWait = online ? waitForConnection(repo, opts.backend) : undefined;
	try {
		report("Fetching repository");
		let folderHandle = await repo.find<unknown>(opts.url as AutomergeUrl);
		if (online) {
			await waitForSync(folderHandle, { idleMs: 1500, maxMs: 15000 });
		}

		let storedUrl: AutomergeUrl = opts.url as AutomergeUrl;
		const branchesDoc = asBranchesDoc(folderHandle.doc());
		if (branchesDoc) {
			if (!opts.onBranchesDoc) {
				throw new Error(
					`URL ${opts.url} is a legacy branches doc; pushwork no longer supports branches. Provide an onBranchesDoc callback (or use the CLI, which will prompt you to pick a branch).`,
				);
			}
			const branches = Object.entries(branchesDoc.branches).map(
				([name, url]) => ({ name, url }),
			);
			const chosenUrl = await opts.onBranchesDoc({
				title: branchesDoc.title,
				branches,
			});
			dlog("clone branches doc → chose %s", chosenUrl);
			folderHandle = await repo.find<unknown>(chosenUrl);
			if (online) {
				await waitForSync(folderHandle, { idleMs: 1500, maxMs: 15000 });
			}
			storedUrl = chosenUrl;
		}

		if (isDraftDoc(folderHandle.doc())) {
			throw new Error(
				`${opts.url} is a draft, which doesn't name its root: clone the root with --draft ${opts.url}`,
			);
		}
		let draft: AutomergeUrl | null = null;
		if (opts.draft !== undefined) {
			draft = await draftOps.resolveDraft(repo, folderHandle as DocHandle<HasOverlays>, opts.draft);
		}

		const { shape, shapeName } = await resolveCloneShape({
			opts,
			repo,
			root,
			online,
			folderHandle,
		});

		const checkout = await openTree(repo, storedUrl, draft);
		const tree = await shape.decode({ repo: checkout.repo, root: checkout.root });
		const fileCount = flattenLeaves(tree).size;
		report(`Downloading ${fileCount} ${fileCount === 1 ? "file" : "files"}`);
		const bases = await materializeTree(
			checkout.repo,
			root,
			tree,
			await treeDatatypes(checkout.repo, tree),
		);

		// Now that the tree (including any `.pushworkattributes` files) is on
		// disk, decide what to record locally. If the repo carries its own
		// artifact attributes, leave config.json's list empty so it defers to
		// them and never triggers an override warning on later operations.
		const cloned = attributesTreeOf(await walkDir(root, await loadIgnore(root)));
		const artifactDirs = cloned.hasArtifactRules
			? []
			: normalizeDirs(opts.artifactDirectories ?? DEFAULT_ARTIFACT_DIRECTORIES);

		// Bring main and every draft along, so switching works offline.
		if (online) {
			if (draft) await treeMembers(repo, shape, folderHandle);
			await touchDrafts(repo, storedUrl).catch((err) =>
				dlog("fetching drafts failed: %s", err instanceof Error ? err.message : err),
			);
		}

		// Confirm we hold everything the server has for the root doc before we
		// declare the clone done, and capture both head sets for reporting.
		const sync = online
			? await waitForServerSync(repo, folderHandle, opts.backend, {
					idleMs: 1500,
					maxMs: 15000,
				})
			: undefined;

		await writeConfig(root, {
			version: CONFIG_VERSION,
			rootUrl: storedUrl,
			backend: opts.backend,
			shape: shapeName,
			artifactDirectories: artifactDirs,
			jsonDocuments: opts.jsonDocuments ?? false,
			draft,
		});
		await writeBases(root, bases);
		await attachConnectMs(sync, connWait);
		dlog("clone complete files=%d synced=%s", fileCount, sync?.synced);
		return { url: storedUrl, files: fileCount, sync };
	} finally {
		await safeShutdown(repo);
	}
}

/** The tree a command works on: the root as the checked-out draft has it,
 * and the repo that reads and writes that draft. */
type Tree = {
	repo: Repo;
	root: DocHandle<unknown>;
	rootUrl: AutomergeUrl;
	draft: DocHandle<DraftDoc> | null;
};

async function openTree(
	repo: Repo,
	rootUrl: AutomergeUrl,
	draft: AutomergeUrl | null,
): Promise<Tree> {
	if (!draft) return { repo, root: await repo.find<unknown>(rootUrl), rootUrl, draft: null };
	const view = await DraftView.open(repo, draft);
	return { repo: view.repo, root: await view.repo.find<unknown>(rootUrl), rootUrl, draft: view.draft };
}

// Reads `doc["@patchwork"].type` if present (e.g. "directory", "folder").
function patchworkType(doc: unknown): string | undefined {
	if (!doc || typeof doc !== "object") return undefined;
	const meta = (doc as Record<string, unknown>)["@patchwork"];
	if (!meta || typeof meta !== "object") return undefined;
	const t = (meta as Record<string, unknown>).type;
	return typeof t === "string" ? t : undefined;
}

// Reads a `.pushworkStrategy` automerge URL off the root doc, if present.
function strategyUrl(doc: unknown): AutomergeUrl | undefined {
	if (!doc || typeof doc !== "object") return undefined;
	const v = (doc as Record<string, unknown>)[".pushworkStrategy"];
	return typeof v === "string" && isValidAutomergeUrl(v) ? v : undefined;
}

// Picks the shape to decode a cloned repo with, based on the root doc:
//   @patchwork.type === "directory" → vfs
//   @patchwork.type === "folder"    → patchwork-folder
//   otherwise, if a `.pushworkStrategy` URL is present, prompt (via
//     opts.onStrategyDoc) to download + run it as a custom shape
//   otherwise, fall back to the explicitly requested opts.shape
// Returns the resolved Shape plus the name to record in config (a builtin
// name, a repo-relative path to the downloaded strategy, or opts.shape).
async function resolveCloneShape(args: {
	opts: CloneOpts;
	repo: Repo;
	root: string;
	online: boolean;
	folderHandle: DocHandle<unknown>;
}): Promise<{ shape: Shape; shapeName: string }> {
	const { opts, repo, root, online, folderHandle } = args;
	const doc = folderHandle.doc();

	const type = patchworkType(doc);
	if (type === "directory") {
		dlog("clone shape: @patchwork.type=directory → vfs");
		return { shape: vfsShape, shapeName: "vfs" };
	}
	if (type === "folder") {
		dlog("clone shape: @patchwork.type=folder → patchwork-folder");
		return { shape: patchworkFolderShape, shapeName: "patchwork-folder" };
	}

	const sUrl = strategyUrl(doc);
	if (sUrl) {
		dlog("clone shape: root doc declares .pushworkStrategy=%s", sUrl);
		if (!opts.onStrategyDoc) {
			throw new Error(
				`root doc has no recognized @patchwork.type and declares a .pushworkStrategy (${sUrl}); refusing to download and run it without confirmation. Provide an onStrategyDoc callback (the CLI prompts you), or pass --shape explicitly.`,
			);
		}
		const strategyHandle = await repo.find<UnixFileEntry>(sUrl);
		if (online) {
			await waitForSync(strategyHandle as DocHandle<unknown>, {
				idleMs: 1500,
				maxMs: 15000,
			});
		}
		const { bytes } = readFileEntry(strategyHandle as DocHandle<unknown>);
		const code = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
		const approved = await opts.onStrategyDoc({ url: sUrl, viewCode: () => code });
		if (approved) {
			const dest = path.join(pushworkDir(root), "strategy.mjs");
			await fs.writeFile(dest, code, "utf8");
			const shapeName = path.relative(root, dest);
			dlog("clone shape: wrote strategy to %s, running it", dest);
			return { shape: await loadCustomShape(dest), shapeName };
		}
		dlog("clone shape: user declined strategy, falling back to opts.shape");
	}

	dlog("clone shape: falling back to opts.shape=%s", opts.shape);
	return { shape: await resolveShape(opts.shape), shapeName: opts.shape };
}

function asBranchesDoc(
	doc: unknown,
): { title?: string; branches: Record<string, AutomergeUrl> } | null {
	if (!doc || typeof doc !== "object") return null;
	const meta = (doc as Record<string, unknown>)["@patchwork"];
	if (!meta || typeof meta !== "object") return null;
	if ((meta as Record<string, unknown>).type !== "branches") return null;
	const branches = (doc as Record<string, unknown>).branches;
	if (!branches || typeof branches !== "object") return null;
	return {
		title: (meta as { title?: string }).title,
		branches: branches as Record<string, AutomergeUrl>,
	};
}

export async function url(cwd: string): Promise<AutomergeUrl> {
	const config = await readConfig(path.resolve(cwd));
	return config.rootUrl;
}

/**
 * Resolve the sync backend + storage for the detached `yoink`/`yeet` commands.
 * These act on a single doc by URL and don't touch the tracked tree, so they
 * work even outside a pushwork repo — no `.pushwork/config.json` required. When
 * a config is present its backend and on-disk storage are reused (so a legacy
 * repo keeps talking to the legacy server, and fetched docs land in the repo's
 * cache); otherwise we fall back to `backend ?? "subduction"` and an ephemeral
 * temp storage dir that `cleanup` removes on shutdown. An explicit `backend`
 * always wins over the config's.
 */
async function openDetachedRepo(
	root: string,
	backend?: Backend,
): Promise<{ repo: Repo; backend: Backend; cleanup: () => Promise<void> }> {
	if (await configExists(root)) {
		const config = await readConfig(root);
		const resolved = backend ?? config.backend;
		const repo = await openRepo(resolved, storageDir(root), {
			offline: false,
		});
		return { repo, backend: resolved, cleanup: () => safeShutdown(repo) };
	}
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-"));
	dlog("openDetachedRepo no config; ephemeral storage=%s", tmp);
	const resolved = backend ?? "subduction";
	const repo = await openRepo(resolved, tmp, { offline: false });
	return {
		repo,
		backend: resolved,
		cleanup: async () => {
			await safeShutdown(repo);
			await fs.rm(tmp, { recursive: true, force: true });
		},
	};
}

/**
 * Pull a single UnixFileEntry doc from `docUrl` and write its content to a
 * file on disk; any other doc is written out as JSON. Online: fetches the
 * doc from the sync server. `destPath` (relative to the repo root) overrides
 * where it lands; if omitted, a file doc's own `name` field is used. Detached — the written file is an ordinary
 * working-tree file, not linked to `docUrl`; a later `save`/`sync` will track
 * it under a fresh file doc like any other path. Works outside a pushwork repo;
 * `backend` overrides the sync backend (default: the repo's config, else
 * subduction).
 */
export async function yoink(
	cwd: string,
	docUrl: string,
	destPath?: string,
	backend?: Backend,
): Promise<{ path: string; bytes: number; url: AutomergeUrl }> {
	if (!isValidAutomergeUrl(docUrl)) {
		throw new Error(`invalid automerge URL: ${docUrl}`);
	}
	const root = path.resolve(cwd);
	dlog("yoink url=%s dest=%s root=%s", docUrl, destPath ?? "(from doc)", root);

	const { repo, cleanup } = await openDetachedRepo(root, backend);
	try {
		const handle = await repo.find<unknown>(docUrl);
		await waitForSync(handle, { idleMs: 1500, maxMs: 15000 });
		const doc = handle.doc();
		const file = isFileEntryDoc(doc) ? readFileEntry(handle) : undefined;
		const bytes = file ? file.bytes : formatJson(jsonValueOf(doc));

		const rel = destPath ?? file?.entry.name;
		if (!rel) {
			throw new Error(
				`doc ${docUrl} has no name field; pass a destination path`,
			);
		}
		const target = path.resolve(root, fromPosix(rel));
		if (!target.startsWith(root + path.sep) && target !== root) {
			throw new Error(`destination escapes the repo: ${rel}`);
		}
		await writeFileAtomic(target, bytes);
		dlog("yoink wrote %s (%d bytes)", target, bytes.length);
		return { path: path.relative(root, target), bytes: bytes.length, url: handle.url };
	} finally {
		await cleanup();
	}
}

/**
 * Push a single file from disk into the UnixFileEntry doc at `docUrl`,
 * mutating it in place (text content merges via Automerge.updateText; binary
 * is last-writer-wins). When `docUrl` is a JSON document, the file must hold
 * a JSON object, which is patched into the doc key by key. Online: publishes the change to the sync server so
 * peers holding `docUrl` see it. Detached — `srcPath` is read straight off
 * disk and need not be tracked by this repo. Works outside a pushwork repo;
 * `backend` overrides the sync backend (default: the repo's config, else
 * subduction).
 */
export async function yeet(
	cwd: string,
	srcPath: string,
	docUrl: string,
	backend?: Backend,
): Promise<{ path: string; bytes: number; url: AutomergeUrl }> {
	if (!isValidAutomergeUrl(docUrl)) {
		throw new Error(`invalid automerge URL: ${docUrl}`);
	}
	const root = path.resolve(cwd);
	const abs = path.resolve(root, fromPosix(srcPath));
	dlog("yeet src=%s url=%s root=%s", abs, docUrl, root);

	const bytes = new Uint8Array(await fs.readFile(abs));
	const fresh = makeFileEntry(srcPath.split(path.sep).join("/"), bytes, false);

	const { repo, backend: resolvedBackend, cleanup } = await openDetachedRepo(
		root,
		backend,
	);
	try {
		const handle = await repo.find<UnixFileEntry>(stripHeads(docUrl));
		// Catch up to the server before overwriting, then confirm our write made
		// it back to the server.
		await waitForServerSync(repo, handle as DocHandle<unknown>, resolvedBackend, {
			idleMs: 1500,
			maxMs: 15000,
		});
		if (isFileEntryDoc(handle.doc())) {
			applyFileEntry(handle, fresh);
		} else {
			const disk = parseJsonObject(bytes);
			if (!disk) {
				throw new Error(
					`${docUrl} is a JSON document; ${srcPath} must hold a JSON object`,
				);
			}
			const value = documentValueOf(disk, jsonValueOf(handle.doc())["@patchwork"]);
			(handle as DocHandle<unknown> as DocHandle<JsonObject>).change(
				(d: JsonObject) => patchJson(d, value),
			);
		}
		await waitForServerSync(repo, handle as DocHandle<unknown>, resolvedBackend, {
			idleMs: 1500,
			maxMs: 15000,
		});
		dlog("yeet pushed %s (%d bytes) → %s", abs, bytes.length, handle.url);
		return { path: srcPath, bytes: bytes.length, url: handle.url };
	} finally {
		await cleanup();
	}
}

export async function sync(
	cwd: string,
	opts: { nuclear?: boolean } = {},
	report: Reporter = noReport,
	warn: Warn = noWarn,
): Promise<SyncSnapshot | undefined> {
	if (opts.nuclear) {
		if ((await readConfig(path.resolve(cwd))).draft) {
			throw new Error("--nuclear rewrites main's documents; run `pushwork switch main` first");
		}
		report("Recreating documents");
		await nuclearizeRepo(cwd);
		report("Publishing to sync server");
		return await publishCurrentTree(cwd);
	}
	return await commitWorkdir(cwd, { online: true }, report, warn);
}

/**
 * Open an online repo, subscribe the root folder and every file leaf so the
 * network adapter announces them to peers, then wait for the local heads to
 * settle. No decode/diff/encode — used after nuclearizeRepo, where every doc
 * is freshly created locally and the server has nothing to merge in.
 */
async function publishCurrentTree(cwd: string): Promise<SyncSnapshot | undefined> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	dlog("publish root=%s", root);

	const repo = await openRepo(config.backend, storageDir(root), { offline: false });
	const connWait = waitForConnection(repo, config.backend);
	try {
		const shape = await resolveShape(config.shape);
		const folderHandle = await repo.find<unknown>(config.rootUrl);
		const tree = await shape.decode({ repo, root: folderHandle });
		// Touch every leaf so the network adapter knows to push it.
		for (const [, fileUrl] of flattenLeaves(tree)) {
			await repo.find<UnixFileEntry>(fileUrl);
		}
		stampLastSyncAt(folderHandle);
		const sync = await waitForServerSync(repo, folderHandle, config.backend, {
			idleMs: 1500,
			maxMs: 15000,
		});
		await attachConnectMs(sync, connWait);
		dlog("publish complete synced=%s", sync.synced);
		return sync;
	} finally {
		await safeShutdown(repo);
	}
}

/**
 * Re-create every UnixFileEntry doc this repo references with a fresh URL,
 * then rewrite the existing folder doc's leaves to point at the new file
 * URLs. The folder doc URL itself is preserved so anyone holding it keeps
 * tracking this repo. Offline; the next sync publishes the new file docs
 * and the rewritten folder doc to the server.
 *
 * The previous file-doc URLs are orphaned from this repo's perspective.
 * Anyone holding one of those URLs directly continues to work from it;
 * this client just stops referencing them.
 */
export async function nuclearizeRepo(cwd: string): Promise<void> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	dlog("nuclear root=%s rootUrl=%s", root, config.rootUrl);

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const folderHandle = await repo.find<unknown>(config.rootUrl);

		const title = path.basename(root) || undefined;
		const oldTree = await shape.decode({ repo, root: folderHandle });
		const isArtifactPath = artifactClassifier(
			attributesTreeOf(await walkDir(root, await loadIgnore(root))),
			config.artifactDirectories,
		);

		// For each leaf: read content, create a fresh doc of the same kind.
		const newTree = newDir();
		const bases: Bases = new Map();
		for (const [posixPath, fileUrl] of flattenLeaves(oldTree)) {
			const bare = stripHeads(fileUrl);
			const oldDoc = (await repo.find<unknown>(bare)).doc();
			const newFileHandle = isFileEntryDoc(oldDoc)
				? repo.create<UnixFileEntry>(copyFileEntry(oldDoc as UnixFileEntry))
				: repo.create<JsonObject>(
						Automerge.toJS(oldDoc as Automerge.Doc<JsonObject>),
					);
			const pinned = pinUrl(newFileHandle);
			bases.set(posixPath, pinned);
			setFileAt(
				newTree,
				posixPath.split("/").filter(Boolean),
				isArtifactPath(posixPath) ? pinned : newFileHandle.url,
				jsonLinkType(oldDoc),
			);
		}

		// Mutate the existing folder doc in place — same URL, new file leaves.
		await shape.encode({
			repo,
			tree: newTree,
			previousRoot: folderHandle,
			title,
		});
		await writeBases(root, bases);
	} finally {
		await safeShutdown(repo);
	}
}

const copyFileEntry = (entry: UnixFileEntry): UnixFileEntry => ({
	"@patchwork": { type: "file" },
	name: entry.name,
	extension: entry.extension,
	mimeType: entry.mimeType,
	content: entry.content,
});

export async function save(
	cwd: string,
	report: Reporter = noReport,
	warn: Warn = noWarn,
): Promise<void> {
	await commitWorkdir(cwd, { online: false }, report, warn);
}

async function commitWorkdir(
	cwd: string,
	{ online }: { online: boolean },
	report: Reporter = noReport,
	warn: Warn = noWarn,
): Promise<SyncSnapshot | undefined> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	dlog("commit online=%s root=%s", online, root);

	const repo = await openRepo(config.backend, storageDir(root), {
		offline: !online,
	});
	const connWait = online ? waitForConnection(repo, config.backend) : undefined;
	try {
		const shape = await resolveShape(config.shape);
		let tree = await openTree(repo, config.rootUrl, config.draft);
		if (
			config.draft &&
			!(await draftOps.isListed(repo, await repo.find<HasOverlays>(config.rootUrl), config.draft))
		) {
			throw new Error(
				`draft "${await draftOps.draftName(repo, config.draft)}" has been merged or deleted; switch to another draft`,
			);
		}

		const ig = await loadIgnore(root);
		report("Scanning working tree");
		const fsFiles = await walkDir(root, ig);
		const attrs = attributesTreeOf(fsFiles);
		const isArtifactPath = artifactClassifier(
			attrs,
			config.artifactDirectories,
			warn,
		);
		const datatypeOf = datatypeClassifier(attrs);

		const previousTree = await shape.decode({ repo: tree.repo, root: tree.root });
		const previousFiles = await readLeaves(
			tree.repo,
			previousTree,
			datatypeOf,
			await readBases(root),
		);

		report(online ? "Committing local changes" : "Writing documents");
		const { tree: newTree, held } = await pushFiles(
			tree.repo,
			fsFiles,
			previousFiles,
			isArtifactPath,
			datatypeOf,
			config.jsonDocuments,
			warn,
		);
		// Shapes only write the folder docs whose links actually changed.
		await shape.encode({
			repo: tree.repo,
			tree: newTree,
			previousRoot: tree.root,
		});

		let sync: SyncSnapshot | undefined;
		if (online) {
			report("Syncing with peers");
			// The same wait pulls peer changes into the local docs and reach disk
			// through the final decode + materialize below. Artifact pins taken by
			// pushFiles above capture our local heads on purpose: publishing means
			// "publish what I have", not "wait for everyone else first".
			sync = await waitForTreeSync(repo, tree, config.backend);
			await touchDrafts(repo, config.rootUrl).catch((err) =>
				dlog("touching drafts failed: %s", err instanceof Error ? err.message : err),
			);
			if (tree.draft) {
				// A peer may have cloned docs into the draft meanwhile, even the
				// same ones; fold those together and read the draft afresh.
				await repairCloneConflicts(repo, tree.draft);
				tree = await openTree(repo, config.rootUrl, config.draft);
			}
		}

		if (online) report("Writing changes");
		const finalTree = await shape.decode({ repo: tree.repo, root: tree.root });
		const bases = await materializeTree(
			tree.repo,
			root,
			finalTree,
			await treeDatatypes(tree.repo, finalTree),
			held,
		);
		await writeBases(root, bases);
		await attachConnectMs(sync, connWait);
		dlog("commit complete synced=%s", sync?.synced);
		return sync;
	} finally {
		await safeShutdown(repo);
	}
}

export type HeadsEntry = {
	path: string; // "/" for the root folder doc, posix file path otherwise
	url: AutomergeUrl;
	heads: string[];
};

/**
 * List the current Automerge heads for the root folder doc and every file
 * leaf it references. Offline; never contacts a sync server.
 *
 * `pathspec` filters results: exact match, or prefix match against a folder
 * (e.g. "src" or "src/" matches "src/index.ts"). Pass "/" to show only the
 * root folder doc.
 */
export async function heads(
	cwd: string,
	pathspec?: string,
): Promise<HeadsEntry[]> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const checkout = await openTree(repo, config.rootUrl, config.draft);
		const tree = await shape.decode({ repo: checkout.repo, root: checkout.root });

		const out: HeadsEntry[] = [];
		const matches = (p: string) => matchesPathspec(p, pathspec);

		if (matches("/")) {
			out.push({
				path: "/",
				url: config.rootUrl,
				heads: checkout.root.heads() ?? [],
			});
		}

		for (const [posixPath, fileUrl] of flattenLeaves(tree)) {
			if (!matches(posixPath)) continue;
			const handle = await checkout.repo.find<UnixFileEntry>(fileUrl);
			out.push({
				path: posixPath,
				url: fileUrl,
				heads: handle.heads() ?? [],
			});
		}

		out.sort((a, b) => a.path.localeCompare(b.path));
		return out;
	} finally {
		await safeShutdown(repo);
	}
}

function matchesPathspec(path: string, spec?: string): boolean {
	if (!spec) return true;
	if (spec === "/") return path === "/";
	const trimmed = spec.endsWith("/") ? spec.slice(0, -1) : spec;
	if (path === trimmed) return true;
	return path.startsWith(trimmed + "/");
}

/** The checked-out draft: its name, and its url (null on main). */
export type DraftRef = { name: string; url: AutomergeUrl | null };

export async function status(cwd: string): Promise<{ diff: Diff; draft: DraftRef }> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const tree = await openTree(repo, config.rootUrl, config.draft);
		const diff = await workingTreeDiff(tree, shape, root);
		return {
			diff,
			draft: { name: await draftOps.draftName(repo, config.draft), url: config.draft },
		};
	} finally {
		await safeShutdown(repo);
	}
}

/** The working tree's changes against the saved state of `tree`. */
async function workingTreeDiff(tree: Tree, shape: Shape, root: string): Promise<Diff> {
	const previousTree = await shape.decode({ repo: tree.repo, root: tree.root });
	const fsFiles = await walkDir(root, await loadIgnore(root));
	const previousFiles = await readLeaves(
		tree.repo,
		previousTree,
		diskDatatypes(fsFiles),
		await readBases(root),
	);
	return computeDiff(previousFiles, fsFiles);
}

export async function diff(
	cwd: string,
	limitToPath?: string,
): Promise<Array<{ path: string; kind: "added" | "modified" | "deleted"; before?: Uint8Array; after?: Uint8Array }>> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const tree = await openTree(repo, config.rootUrl, config.draft);
		const previousTree = await shape.decode({ repo: tree.repo, root: tree.root });
		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);
		const previousFiles = await readLeaves(
			tree.repo,
			previousTree,
			diskDatatypes(fsFiles),
			await readBases(root),
		);

		const out: Array<{ path: string; kind: "added" | "modified" | "deleted"; before?: Uint8Array; after?: Uint8Array }> = [];
		for (const [p, bytes] of fsFiles) {
			if (limitToPath && p !== limitToPath) continue;
			const prev = previousFiles.get(p);
			if (!prev) {
				out.push({ path: p, kind: "added", after: bytes });
			} else if (!leafMatchesDisk(prev, bytes)) {
				// Lay a JSON document out like the disk copy so the diff shows
				// changed values rather than formatting.
				const before = prev.value ? formatJson(prev.value, bytes) : prev.bytes;
				out.push({ path: p, kind: "modified", before, after: bytes });
			}
		}
		for (const [p, prev] of previousFiles) {
			if (limitToPath && p !== limitToPath) continue;
			if (!fsFiles.has(p)) out.push({ path: p, kind: "deleted", before: prev.bytes });
		}
		return out;
	} finally {
		await safeShutdown(repo);
	}
}

/**
 * Capture the working tree's changes against the saved state into a local
 * snarf, then reset the working tree to the saved state. Snarfs live in
 * `.pushwork/snarf/` and are never synced.
 */
export async function cutWorkdir(
	cwd: string,
	opts: { name?: string } = {},
): Promise<{ id: number; entries: number }> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	dlog("cut root=%s name=%s", root, opts.name ?? "(unnamed)");

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const tree = await openTree(repo, config.rootUrl, config.draft);
		const previousTree = await shape.decode({ repo: tree.repo, root: tree.root });
		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);
		const previousFiles = await readLeaves(
			tree.repo,
			previousTree,
			diskDatatypes(fsFiles),
			await readBases(root),
		);

		const entries: SnarfEntry[] = [];
		for (const [p, bytes] of fsFiles) {
			const prev = previousFiles.get(p);
			if (!prev) {
				entries.push({ path: p, kind: "added", contentBase64: encodeBytes(bytes) });
			} else if (!leafMatchesDisk(prev, bytes)) {
				entries.push({
					path: p,
					kind: "modified",
					contentBase64: encodeBytes(bytes),
				});
			}
		}
		for (const [p] of previousFiles) {
			if (!fsFiles.has(p)) entries.push({ path: p, kind: "deleted" });
		}

		if (entries.length === 0) {
			throw new Error("nothing to cut: working tree clean");
		}
		entries.sort((a, b) => a.path.localeCompare(b.path));

		const snarf = await appendSnarf(root, {
			name: opts.name,
			entries,
		});

		// Reset working tree to the saved state.
		const bases = await materializeTree(
			tree.repo,
			root,
			previousTree,
			await treeDatatypes(tree.repo, previousTree),
		);
		await writeBases(root, bases);
		dlog("cut complete id=%d entries=%d", snarf.id, entries.length);
		return { id: snarf.id, entries: entries.length };
	} finally {
		await safeShutdown(repo);
	}
}

/**
 * Apply a snarf on top of the current working tree, then remove the snarf
 * entry. Refuses if the working tree has uncommitted changes (caller can
 * `pushwork save` or `pushwork cut` first).
 */
export async function pasteSnarf(
	cwd: string,
	selector?: string,
): Promise<{ id: number; entries: number; name?: string }> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);

	// Check the working tree is clean against the saved state.
	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const tree = await openTree(repo, config.rootUrl, config.draft);
		if (isDirty(await workingTreeDiff(tree, shape, root))) {
			throw new Error(
				"refusing to paste: working tree has uncommitted changes. run `pushwork save` or `pushwork cut` first.",
			);
		}
	} finally {
		await safeShutdown(repo);
	}

	const snarf = await takeSnarf(root, selector);
	if (!snarf) {
		throw new Error(
			selector
				? `no snarf matches "${selector}"`
				: "nothing to paste: no snarfs",
		);
	}

	for (const entry of snarf.entries) {
		const target = path.join(root, fromPosix(entry.path));
		if (entry.kind === "deleted") {
			try {
				await fs.unlink(target);
			} catch {
				// already gone
			}
			await pruneEmptyDirs(root, path.dirname(fromPosix(entry.path)));
		} else if (entry.contentBase64 != null) {
			const bytes = decodeBytes(entry.contentBase64);
			await writeFileAtomic(target, bytes);
		}
	}

	dlog("paste complete id=%d entries=%d", snarf.id, snarf.entries.length);
	return { id: snarf.id, name: snarf.name, entries: snarf.entries.length };
}

export async function showSnarfs(cwd: string): Promise<Snarf[]> {
	return listSnarfs(path.resolve(cwd));
}

// --- Drafts ------------------------------------------------------------------
// Drafts are stored the way Patchwork stores them (see src/drafts/), so a
// draft made in either shows up in both. The commands are offline; `sync`
// publishes drafts and brings in ones made elsewhere.

/** The root's open drafts, depth-first, and which one is checked out. */
export async function drafts(
	cwd: string,
): Promise<{ root: AutomergeUrl; current: AutomergeUrl | null; drafts: DraftSummary[] }> {
	return withOfflineRepo(cwd, async ({ config, repo }) => {
		const rootHandle = await repo.find<HasOverlays>(config.rootUrl);
		return {
			root: config.rootUrl,
			current: config.draft,
			drafts: await draftOps.listDrafts(repo, rootHandle),
		};
	});
}

export async function currentDraft(cwd: string): Promise<DraftRef> {
	return withOfflineRepo(cwd, async ({ config, repo }) => ({
		name: await draftOps.draftName(repo, config.draft),
		url: config.draft,
	}));
}

/**
 * Fork a new draft off the checked-out draft, or off `start`, and optionally
 * switch to it. Forked off the checked-out draft, the new draft reads exactly
 * what is saved now, so switching to it keeps the working tree as it is,
 * unsaved changes and all; forked off another, switching needs a clean tree.
 */
export async function createDraft(
	cwd: string,
	opts: { name?: string; start?: string; switchTo?: boolean } = {},
): Promise<{ draft: DraftRef; switched: boolean }> {
	return withOfflineRepo(cwd, async ({ root, config, repo }) => {
		const shape = await resolveShape(config.shape);
		const rootHandle = await repo.find<HasOverlays>(config.rootUrl);
		const parent =
			opts.start === undefined
				? config.draft
				: await draftOps.resolveDraft(repo, rootHandle, opts.start);
		const carriesOver = parent === config.draft;
		if (opts.switchTo && !carriesOver) await refuseDirty(repo, config, shape, root, "switch");
		const members = await treeMembers(repo, shape, rootHandle as DocHandle<unknown>);
		const url = await draftOps.forkDraft(repo, rootHandle, members, parent, opts.name);
		const draft = { name: await draftOps.draftName(repo, url), url };
		if (!opts.switchTo) return { draft, switched: false };
		if (carriesOver) await writeConfig(root, { ...config, draft: url });
		else await checkOut(repo, config, shape, root, url);
		return { draft, switched: true };
	});
}

/** Check out another draft (or `main`) and rewrite the working tree to match. */
export async function switchDraft(
	cwd: string,
	ref: string,
): Promise<{ draft: DraftRef; alreadyOn: boolean }> {
	return withOfflineRepo(cwd, async ({ root, config, repo }) => {
		const rootHandle = await repo.find<HasOverlays>(config.rootUrl);
		const target = await draftOps.resolveDraft(repo, rootHandle, ref);
		const draft = { name: await draftOps.draftName(repo, target), url: target };
		if (target === config.draft) return { draft, alreadyOn: true };
		const shape = await resolveShape(config.shape);
		await refuseDirty(repo, config, shape, root, "switch");
		await checkOut(repo, config, shape, root, target);
		return { draft, alreadyOn: false };
	});
}

/**
 * Merge the checked-out draft into the draft it was forked off, then switch
 * to wherever it landed: its parent, or the nearest ancestor that hasn't been
 * merged away, or main.
 */
export async function merge(
	cwd: string,
): Promise<{ from: string; into: DraftRef; merged: number }> {
	return withOfflineRepo(cwd, async ({ root, config, repo }) => {
		if (!config.draft) throw new Error("main has no parent to merge into");
		const shape = await resolveShape(config.shape);
		await refuseDirty(repo, config, shape, root, "merge");
		const rootHandle = await repo.find<HasOverlays>(config.rootUrl);
		const from = await draftOps.draftName(repo, config.draft);
		const { landed, merged } = await draftOps.mergeIntoParent(repo, rootHandle, config.draft);
		await checkOut(repo, config, shape, root, landed);
		return { from, into: { name: await draftOps.draftName(repo, landed), url: landed }, merged };
	});
}

/**
 * Drop a draft from the list without merging it; drafts forked off it list
 * under its parent. Refuses while it's checked out, and unless `force`, while
 * it holds changes that haven't been merged.
 */
export async function deleteDraft(
	cwd: string,
	ref: string,
	{ force = false }: { force?: boolean } = {},
): Promise<DraftRef> {
	return withOfflineRepo(cwd, async ({ config, repo }) => {
		const rootHandle = await repo.find<HasOverlays>(config.rootUrl);
		const target = await draftOps.resolveDraft(repo, rootHandle, ref);
		if (!target) throw new Error("main can't be deleted");
		const name = await draftOps.draftName(repo, target);
		if (config.draft === target) {
			throw new Error(`can't delete "${name}" while it is checked out; switch to another draft first`);
		}
		if (!force && (await draftOps.hasUnmergedChanges(repo, target))) {
			throw new Error(`draft "${name}" has changes that haven't been merged; use -D to delete it anyway`);
		}
		await draftOps.deleteDraft(repo, rootHandle, target);
		return { name, url: target };
	});
}

/** Rename the checked-out draft, or the one `ref` names. */
export async function renameDraft(
	cwd: string,
	name: string,
	ref?: string,
): Promise<{ from: string; to: string }> {
	return withOfflineRepo(cwd, async ({ config, repo }) => {
		const rootHandle = await repo.find<HasOverlays>(config.rootUrl);
		const target =
			ref === undefined ? config.draft : await draftOps.resolveDraft(repo, rootHandle, ref);
		if (!target) throw new Error("main can't be renamed");
		const from = await draftOps.draftName(repo, target);
		await draftOps.renameDraft(repo, rootHandle, target, name);
		return { from, to: name };
	});
}

/** A draft's url (`pushwork clone <root> --draft <url>` checks it out); the root's for main. */
export async function draftUrl(cwd: string, ref?: string): Promise<AutomergeUrl> {
	return withOfflineRepo(cwd, async ({ config, repo }) => {
		const target =
			ref === undefined
				? config.draft
				: await draftOps.resolveDraft(repo, await repo.find<HasOverlays>(config.rootUrl), ref);
		return target ?? config.rootUrl;
	});
}

async function withOfflineRepo<T>(
	cwd: string,
	fn: (ctx: { root: string; config: PushworkConfig; repo: Repo }) => Promise<T>,
): Promise<T> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		return await fn({ root, config, repo });
	} finally {
		await safeShutdown(repo);
	}
}

async function refuseDirty(
	repo: Repo,
	config: PushworkConfig,
	shape: Shape,
	root: string,
	verb: string,
): Promise<void> {
	const tree = await openTree(repo, config.rootUrl, config.draft);
	if (!isDirty(await workingTreeDiff(tree, shape, root))) return;
	const name = await draftOps.draftName(repo, config.draft);
	throw new Error(
		`refusing to ${verb}: the working tree has unsaved changes. ` +
			`run \`pushwork save\` to keep them on ${name}, or \`pushwork cut\` to set them aside and \`pushwork paste\` them after.`,
	);
}

// Point the checkout at `draft` and make the working tree and its merge
// bases match it.
async function checkOut(
	repo: Repo,
	config: PushworkConfig,
	shape: Shape,
	root: string,
	draft: AutomergeUrl | null,
): Promise<void> {
	const tree = await openTree(repo, config.rootUrl, draft);
	const decoded = await shape.decode({ repo: tree.repo, root: tree.root });
	const bases = await materializeTree(
		tree.repo,
		root,
		decoded,
		await treeDatatypes(tree.repo, decoded),
	);
	await writeBases(root, bases);
	await writeConfig(root, { ...config, draft });
}

const SERVER_WAIT = { idleMs: 1500, maxMs: 15000 };

/**
 * Confirm the server has caught up with the tree, pulling peer changes in.
 * On main that's the root, stamped with `lastSyncAt` (a sync is also a
 * checkpoint that "we reconciled with the server at this time"). On a draft
 * it's the draft doc, which lists the draft's clones, and the draft's clone
 * of the root; the root itself is main's and isn't stamped.
 */
async function waitForTreeSync(repo: Repo, tree: Tree, backend: Backend): Promise<SyncSnapshot> {
	if (!tree.draft) {
		stampLastSyncAt(tree.root);
		return waitForServerSync(repo, tree.root, backend, SERVER_WAIT);
	}
	const rootClone = tree.draft.doc()?.clones?.[canonicalUrl(tree.rootUrl)]?.cloneUrl;
	const [draft, root] = await Promise.all([
		waitForServerSync(repo, tree.draft, backend, SERVER_WAIT),
		rootClone
			? repo.find<unknown>(rootClone).then((h) => waitForServerSync(repo, h, backend, SERVER_WAIT))
			: undefined,
	]);
	if (!root) return draft;
	const synced = draft.synced && root.synced;
	return { ...root, synced, pending: !synced && (draft.pending || root.pending) };
}

/**
 * Load the root's overlays and every doc they read (the originals they
 * forked, their clones, and the clones they forked off), so those go out
 * with this sync even when made while another draft was checked out, and
 * overlays made elsewhere come in whole.
 */
async function touchDrafts(repo: Repo, rootUrl: AutomergeUrl): Promise<void> {
	const index = await draftOps.findIndex(repo, await repo.find<HasOverlays>(rootUrl));
	if (!index) return;
	const overlays = [...(index.doc()?.drafts ?? []), ...(index.doc()?.merges ?? [])];
	const urls = new Set<AutomergeUrl>();
	for (const overlay of overlays) {
		let clones: Record<AutomergeUrl, CloneEntry>;
		try {
			clones = (await repo.find<DraftDoc | MergeDoc>(overlay)).doc()?.clones ?? {};
		} catch {
			continue;
		}
		for (const [original, entry] of Object.entries(clones) as [AutomergeUrl, CloneEntry][]) {
			for (const url of [original, entry.cloneUrl, entry.source]) if (url) urls.add(url);
		}
	}
	await Promise.all([...urls].map((url) => repo.find<unknown>(url).catch(() => undefined)));
}

type Stamped = { lastSyncAt?: number };

function stampLastSyncAt(handle: DocHandle<unknown>): void {
	(handle as DocHandle<Stamped>).change((d: Stamped) => {
		d.lastSyncAt = Date.now();
	});
}

/**
 * Await the connection probe started at repo-open and stamp its measured connect
 * time (and any server peer id) onto the sync snapshot.
 */
async function attachConnectMs(
	sync: SyncSnapshot | undefined,
	connWait: Promise<Connection> | undefined,
): Promise<void> {
	if (!connWait) return;
	const conn = await connWait;
	if (sync) {
		sync.connectMs = conn.connectMs;
		if (sync.serverPeerId == null) sync.serverPeerId = conn.serverPeerId;
	}
}

function normalizeDirs(dirs: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const d of dirs) {
		const norm = normalizeArtifactDir(d);
		if (!norm || seen.has(norm)) continue;
		seen.add(norm);
		out.push(norm);
	}
	return out;
}

const isDirty = (d: Diff): boolean =>
	d.added.length + d.modified.length + d.deleted.length > 0;

function computeDiff(
	previous: Map<string, StoredLeaf>,
	current: Map<string, Uint8Array>,
): Diff {
	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];
	for (const [p, bytes] of current) {
		const prev = previous.get(p);
		if (!prev) added.push(p);
		else if (!leafMatchesDisk(prev, bytes)) modified.push(p);
	}
	for (const p of previous.keys()) {
		if (!current.has(p)) deleted.push(p);
	}
	added.sort();
	modified.sort();
	deleted.sort();
	return { added, modified, deleted };
}

/**
 * Record the working tree into leaf docs, reconciling each path against its
 * merge base in `previous`. Returns the new tree, each path's version as
 * recorded (`bases`), and the paths `held` at their old base because their
 * disk copy isn't the JSON object their document needs; materialize must
 * leave those files alone.
 *
 * The tree links each document bare, so Patchwork opens it live; only
 * artifacts are pinned at the recorded version, so consumers of build output
 * get an exact snapshot.
 *
 * A path already tracked as a JSON document stays one. Otherwise a file that
 * qualifies ({@link jsonDocumentOf}) gets a new JSON document when
 * `jsonDocuments` is on or a `datatype` rule covers it — for a path tracked
 * as text until now, that replaces its file doc and URL. A JSON document's
 * `@patchwork` field is rebuilt from its `datatype` rule and, where the disk
 * copy lacks it, from the document.
 */
export async function pushFiles(
	repo: Repo,
	fsFiles: Map<string, Uint8Array>,
	previous: Map<string, StoredLeaf> | undefined,
	isArtifactPath: IsArtifact,
	datatypeOf: DatatypeOf,
	jsonDocuments: boolean,
	warn: Warn,
): Promise<{ tree: VfsNode; bases: Bases; held: Bases }> {
	const root = newDir();
	const bases: Bases = new Map();
	const held: Bases = new Map();
	const linkTo = (posixPath: string, pinned: AutomergeUrl) =>
		isArtifactPath(posixPath) ? pinned : stripHeads(pinned);
	let created = 0;
	let updated = 0;
	let unchanged = 0;
	for (const [posixPath, bytes] of fsFiles) {
		const segments = posixPath.split("/").filter(Boolean);
		const prev = previous?.get(posixPath);
		const datatype = datatypeOf(posixPath);
		const json =
			(jsonDocuments || datatype) && !prev?.value
				? jsonDocumentOf(posixPath, bytes, datatype)
				: undefined;

		let handle: DocHandle<unknown>;
		if (prev?.value) {
			const base = withMeta(prev.value, prev.meta);
			const disk = parseJsonObject(bytes);
			if (!disk) {
				warn(
					`${posixPath} is synced as a JSON document but isn't a JSON object on disk; leaving it unsynced until it is`,
				);
				held.set(posixPath, prev.url);
				bases.set(posixPath, prev.url);
				setFileAt(root, segments, linkTo(posixPath, prev.url), jsonLinkType(base));
				continue;
			}
			const value = documentValueOf(disk, base["@patchwork"], datatype);
			handle = await repo.find<unknown>(stripHeads(prev.url));
			if (jsonEquals(base, value)) {
				unchanged++;
			} else {
				applyJsonEdit(handle as DocHandle<JsonObject>, prev.url, base, value);
				updated++;
				dlog("pushFiles updated json %s url=%s", posixPath, handle.url);
			}
		} else if (json) {
			handle = repo.create<JsonObject>(json);
			created++;
			dlog(
				"pushFiles %s json %s url=%s",
				prev ? "converted" : "created",
				posixPath,
				handle.url,
			);
		} else if (prev) {
			// Existing path: mutate the file doc in place. This keeps the file
			// URL stable across edits and avoids the propagation race where a
			// brand-new file doc URL is referenced by the folder before its
			// bytes have reached the server. The base's heads are the merge
			// base; strip them to get the live, editable doc.
			handle = await repo.find<unknown>(stripHeads(prev.url));
			if (byteEq(prev.bytes, bytes)) {
				unchanged++;
			} else {
				applyDiskEdit(
					handle as DocHandle<UnixFileEntry>,
					prev,
					makeFileEntry(posixPath, bytes, isArtifactPath(posixPath)),
					bytes,
				);
				updated++;
				dlog("pushFiles updated %s url=%s bytes=%d", posixPath, handle.url, bytes.length);
			}
		} else {
			// New path: create a fresh file doc.
			handle = repo.create<UnixFileEntry>(
				makeFileEntry(posixPath, bytes, isArtifactPath(posixPath)),
			);
			created++;
			dlog("pushFiles created %s url=%s bytes=%d", posixPath, handle.url, bytes.length);
		}

		// The doc's current heads are this path's recorded version: the merge
		// base until materialize replaces it with the version it writes. An
		// unchanged path whose doc moved underneath us (a peer's edit already
		// in local storage) records the tip, publishing what we can see.
		const pinned = pinUrl(handle);
		bases.set(posixPath, pinned);
		setFileAt(root, segments, linkTo(posixPath, pinned), jsonLinkType(handle.doc()));
	}
	dlog("pushFiles done: %d created, %d updated, %d unchanged, %d held", created, updated, unchanged, held.size);
	return { tree: root, bases, held };
}

/**
 * Record a disk edit on a file doc. `prev` is the folder link the disk copy
 * was materialized from: its pinned heads are the merge base, its bytes the
 * base content. Three cases:
 *
 * - The live tip already holds the disk bytes (our own earlier change, or a
 *   peer wrote the same content): nothing to record. Recording it anyway at
 *   the base would land the same edit twice — Automerge does not dedupe
 *   identical concurrent splices, so the text would duplicate.
 * - The tip still matches the base: a plain local edit, recorded at the tip.
 * - Both moved: record the edit *at the base heads* so it lands as a change
 *   concurrent with the tip's, and Automerge merges the two instead of the
 *   disk diff undoing the tip's edits.
 *
 * A link without heads (last written before universal pinning) has no base;
 * fall back to editing the tip. The first sync of this version pins every
 * link, so that happens once per repo.
 */
function applyDiskEdit(
	handle: DocHandle<UnixFileEntry>,
	prev: StoredLeaf,
	fresh: UnixFileEntry,
	bytes: Uint8Array,
): void {
	const tipBytes = contentToBytes(handle.doc().content);
	if (byteEq(tipBytes, bytes)) return;
	const base = urlHeads(prev.url);
	if (base === undefined || byteEq(tipBytes, prev.bytes)) {
		applyFileEntry(handle, fresh);
		return;
	}
	dlog("pushFiles merging %s at base %s", prev.url, base.join("|"));
	handle.changeAt(base, (d: UnixFileEntry) => mutateFileEntry(d, fresh));
}

/**
 * {@link applyDiskEdit} for a JSON document: the same three cases, comparing
 * values instead of bytes. The patch is computed against the version it is
 * recorded on (the tip, or the doc at the base heads), so it touches only
 * the keys the disk edit changed and a concurrent edit elsewhere survives.
 */
function applyJsonEdit(
	handle: DocHandle<JsonObject>,
	linkUrl: AutomergeUrl,
	baseValue: JsonObject,
	value: JsonObject,
): void {
	const tip = jsonValueOf(handle.doc());
	if (jsonEquals(tip, value)) return;
	const base = urlHeads(linkUrl);
	if (base === undefined || jsonEquals(tip, baseValue)) {
		handle.change((d: JsonObject) => patchJson(d, value));
		return;
	}
	dlog("pushFiles merging json %s at base %s", linkUrl, base.join("|"));
	handle.changeAt(base, (d: JsonObject) => patchJson(d, value));
}

/** Read every leaf of `tree` at its merge base ({@link baseOf}), as it
 * should appear on disk: JSON documents whose datatype strips metadata come
 * without their `@patchwork` field. */
export async function readLeaves(
	repo: Repo,
	tree: VfsNode,
	datatypeOf: DatatypeOf,
	bases: Bases,
): Promise<Map<string, StoredLeaf>> {
	const out = new Map<string, StoredLeaf>();
	for (const [posixPath, fileUrl] of flattenLeaves(tree)) {
		const base = baseOf(fileUrl, bases.get(posixPath));
		const handle = await repo.find<unknown>(base);
		out.set(posixPath, {
			url: base,
			...leafContent(handle.doc(), isStripped(datatypeOf, posixPath)),
		});
	}
	return out;
}

/**
 * The datatype rules carried by `tree`'s own `.pushworkattributes` files,
 * read from their documents — so a tree can be written out with its rules
 * applied before those files are on disk.
 */
async function treeDatatypes(repo: Repo, tree: VfsNode): Promise<DatatypeOf> {
	const files = new Map<string, Uint8Array>();
	for (const [posixPath, fileUrl] of flattenLeaves(tree)) {
		if (posixPath.split("/").pop() !== ATTRIBUTES_FILE) continue;
		files.set(posixPath, leafContent((await repo.find<unknown>(fileUrl)).doc()).bytes);
	}
	return datatypeClassifier(attributesTreeOf(files));
}

const isStripped = (datatypeOf: DatatypeOf, posixPath: string): boolean =>
	datatypeOf(posixPath)?.stripMetadata ?? false;

/**
 * Make the working tree match `tree`, and return the version each path now
 * reflects: the merge bases for the next sync. A bare link is written at the
 * doc's tip, a pinned one at its pin. A JSON document is only written when
 * its value differs from the disk copy, laid out like that copy, and without
 * its `@patchwork` field when its datatype strips it; `held` paths are never
 * written and keep their base.
 */
async function materializeTree(
	repo: Repo,
	root: string,
	tree: VfsNode,
	datatypeOf: DatatypeOf,
	held: ReadonlyMap<string, AutomergeUrl> = new Map(),
): Promise<Bases> {
	const leaves = flattenLeaves(tree);

	// Fetch all leaves concurrently: a single Subduction connection
	// multiplexes concurrent `repo.find`s, so per-doc sync round-trips overlap
	// instead of serializing (benched vs serial and vs the old worker pool in
	// ADR-031/032). The transport's own receive-credit windowing is the
	// backpressure; no artificial cap here.
	const desired = new Map<string, StoredLeaf>();
	await Promise.all(
		[...leaves].map(async ([posixPath, fileUrl]) => {
			const handle = await repo.find<unknown>(fileUrl);
			desired.set(posixPath, {
				url: urlHeads(fileUrl) ? fileUrl : pinUrl(handle),
				...leafContent(handle.doc(), isStripped(datatypeOf, posixPath)),
			});
		}),
	);
	dlog("materialize desired: %d files", desired.size);
	// Invariant: every leaf was fetched. The loop below DELETES anything on
	// disk that isn't in `desired`, so a silent fetch shortfall must be a loud
	// error here rather than a tree wipe.
	if (desired.size !== leaves.size) {
		throw new Error(
			`materialize fetched ${desired.size} of ${leaves.size} documents; refusing to reconcile a partial tree`,
		);
	}

	const ig = await loadIgnore(root);
	const present = await walkDir(root, ig);

	const bases: Bases = new Map();
	let written = 0;
	let removed = 0;
	for (const [posixPath, leaf] of desired) {
		const kept = held.get(posixPath);
		bases.set(posixPath, kept ?? leaf.url);
		const onDisk = present.get(posixPath);
		if (kept || leafMatchesDisk(leaf, onDisk)) continue;
		const bytes = leaf.value ? formatJson(leaf.value, onDisk) : leaf.bytes;
		await writeFileAtomic(path.join(root, fromPosix(posixPath)), bytes);
		written++;
	}
	for (const posixPath of present.keys()) {
		if (desired.has(posixPath)) continue;
		try {
			await fs.unlink(path.join(root, fromPosix(posixPath)));
			removed++;
		} catch {
			// already gone
		}
		await pruneEmptyDirs(root, path.dirname(fromPosix(posixPath)));
	}
	dlog("materialize done: %d written, %d removed", written, removed);
	return bases;
}

const fromPosix = (p: string) => p.split("/").join(path.sep);

async function pruneEmptyDirs(root: string, relDir: string): Promise<void> {
	let dir = relDir;
	while (dir && dir !== "." && dir !== path.sep) {
		const full = path.join(root, dir);
		try {
			const entries = await fs.readdir(full);
			if (entries.length > 0) return;
			await fs.rmdir(full);
		} catch {
			return;
		}
		dir = path.dirname(dir);
	}
}

export type { Shape, UnixFileEntry, VfsNode, PushworkConfig };
