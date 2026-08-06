import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
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
import { ATTRIBUTES_FILE, readAttributes } from "./attributes.js";
import { byteEq, walkDir, writeFileAtomic } from "./fs-tree.js";
import { log } from "./log.js";
import {
	confirmDelivery,
	findBounded,
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
	flattenLeaves,
	isInArtifactDir,
	makeFileEntry,
	newDir,
	normalizeArtifactDir,
	patchworkFolderShape,
	pinUrl,
	readFileEntry,
	resolveShape,
	setFileAt,
	stripHeads,
	vfsShape,
	type Shape,
	type UnixFileEntry,
	type VfsNode,
} from "./shapes/index.js";
import { loadCustomShape } from "./shapes/custom.js";

const dlog = log("pushwork");

const DEFAULT_ARTIFACT_DIRECTORIES = ["dist"];

/** Called at phase boundaries of long operations so the CLI can show progress. */
export type Reporter = (phase: string) => void;
const noReport: Reporter = () => {};

/** Surfaces a non-fatal warning (e.g. a settings override) to the user. */
export type Warn = (message: string) => void;
const noWarn: Warn = () => {};

/** Decides whether a repo-relative posix path is an artifact (stored as an
 *  immutable, heads-pinned blob rather than a live CRDT doc). */
type IsArtifact = (posixPath: string) => boolean;

/**
 * Build the artifact classifier for an operation. A repo-level
 * `.pushworkattributes` file travels with the repo content, so its `artifact`
 * rules take precedence over the local `.pushwork/config.json`
 * `artifactDirectories`. When the attributes file is present *and* the local
 * config also lists directories, we warn — the local list is being ignored in
 * favor of the one the repo carries.
 */
async function resolveIsArtifact(
	root: string,
	configDirs: readonly string[],
	warn: Warn = noWarn,
): Promise<IsArtifact> {
	const attrs = await readAttributes(root);
	if (attrs?.hasArtifactRules) {
		if (configDirs.length > 0) {
			warn(
				`${ATTRIBUTES_FILE} defines artifact paths and overrides ` +
					`artifactDirectories [${configDirs.join(", ")}] from .pushwork/config.json`,
			);
		}
		dlog("artifact source: %s", ATTRIBUTES_FILE);
		return (p) => attrs.isArtifact(p);
	}
	dlog("artifact source: config artifactDirectories %o", configDirs);
	return (p) => isInArtifactDir(p, configDirs);
}

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
	online?: boolean; // default: true
	/**
	 * Delivery-confirmation stalled with docs outstanding (after the built-in
	 * retries): resolve true to keep waiting, false to finish as PENDING.
	 * Omitted ⇒ finish as PENDING (non-interactive behavior).
	 */
	onConfirmStalled?: (unconfirmed: number, total: number) => Promise<boolean>;
	/** Confirmation progress ticks (for progress bars); default: phase report. */
	onConfirmProgress?: (confirmed: number, total: number) => void;
};

export type CloneOpts = {
	url: string;
	dir: string;
	backend: Backend;
	shape: string;
	artifactDirectories?: readonly string[];
	online?: boolean; // default: true
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
	// A `.pushworkattributes` file already in the working tree is authoritative;
	// keep config.json's artifactDirectories empty so it never fights the
	// repo-carried attributes (and never triggers an override warning later).
	const attrs = await readAttributes(root);
	if (attrs?.hasArtifactRules && opts.artifactDirectories?.length) {
		warn(
			`${ATTRIBUTES_FILE} defines artifact paths; ignoring --artifact-dir ` +
				`[${opts.artifactDirectories.join(", ")}]`,
		);
	}
	const artifactDirs = attrs?.hasArtifactRules
		? []
		: normalizeDirs(opts.artifactDirectories ?? DEFAULT_ARTIFACT_DIRECTORIES);
	const isArtifactPath: IsArtifact = attrs?.hasArtifactRules
		? (p) => attrs.isArtifact(p)
		: (p) => isInArtifactDir(p, artifactDirs);
	dlog("init artifactDirs=%o attributes=%s", artifactDirs, Boolean(attrs?.hasArtifactRules));
	await fs.mkdir(pushworkDir(root), { recursive: true });

	const repo = await openRepo(opts.backend, storageDir(root), { offline: !online });
	// Start measuring the connection now so the local walk/encode overlaps it.
	const connWait = online ? waitForConnection(repo, opts.backend) : undefined;
	try {
		const shape = await resolveShape(opts.shape);
		const ig = await loadIgnore(root);
		report("Reading working tree");
		const fsFiles = await walkDir(root, ig);
		dlog("init walked %d files", fsFiles.size);

		const title = path.basename(root) || undefined;
		report(`Encoding ${fsFiles.size} ${fsFiles.size === 1 ? "file" : "files"}`);
		const { tree, changedUrls } = await pushFiles(
			repo,
			fsFiles,
			undefined,
			isArtifactPath,
		);
		const folderDocUrls: AutomergeUrl[] = [];
		const folderUrl = await shape.encode({
			repo,
			tree,
			title,
			isArtifactDir: isArtifactPath,
			onDocChanged: (u) => folderDocUrls.push(u),
		});
		dlog("init encoded folder=%s title=%s", folderUrl, title);
		const folderHandle = await repo.find<unknown>(folderUrl);

		let sync: SyncSnapshot | undefined;
		if (online) {
			report(
				`Publishing ${fsFiles.size} ${fsFiles.size === 1 ? "file" : "files"} to the sync server`,
			);
			stampLastSyncAt(folderHandle);
			// Confirm leaf AND intermediate folder docs alongside the root doc — a
			// clone resolves the whole tree against the server, so every doc must
			// land, not just the root (nested-tree clones flaked on exactly this).
			const leafConfirm = confirmDocs(
				repo,
				[...changedUrls, ...folderDocUrls.filter((u) => u !== folderUrl)],
				opts.backend,
				connWait,
				{
					onProgress:
						opts.onConfirmProgress ??
						((confirmed, total) =>
							report(`Confirming delivery (${confirmed}/${total})`)),
					onStalled: opts.onConfirmStalled,
				},
			);
			sync = await waitForServerSync(repo, folderHandle, opts.backend, {
				idleMs: 1500,
				maxMs: 15000,
			});
			sync = degradeUnconfirmed(sync, await leafConfirm);
		}

		await writeConfig(root, {
			version: CONFIG_VERSION,
			rootUrl: folderUrl,
			backend: opts.backend,
			shape: opts.shape,
			artifactDirectories: artifactDirs,
		});
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
		// Gate the initial find on the server handshake: with an empty local
		// store and a socket still connecting, `find` can resolve "unavailable"
		// before the server was ever asked.
		if (connWait) await connWait;
		let folderHandle: DocHandle<unknown> = await findBounded<unknown>(
			repo,
			opts.url as AutomergeUrl,
		);
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
			folderHandle = await findBounded<unknown>(repo, chosenUrl);
			if (online) {
				await waitForSync(folderHandle, { idleMs: 1500, maxMs: 15000 });
			}
			storedUrl = chosenUrl;
		}

		const { shape, shapeName } = await resolveCloneShape({
			opts,
			repo,
			root,
			online,
			folderHandle,
		});

		const tree = await shape.decode({ repo, root: folderHandle });
		const fileCount = flattenLeaves(tree).size;
		report(`Downloading ${fileCount} ${fileCount === 1 ? "file" : "files"}`);
		await materializeTree(repo, root, tree);

		// Now that the tree (including any `.pushworkattributes`) is on disk,
		// decide what to record locally. If the repo carries its own artifact
		// attributes, leave config.json's list empty so it defers to them and
		// never triggers an override warning on later operations.
		const cloned = await readAttributes(root);
		const artifactDirs = cloned?.hasArtifactRules
			? []
			: normalizeDirs(opts.artifactDirectories ?? DEFAULT_ARTIFACT_DIRECTORIES);

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
		});
		await attachConnectMs(sync, connWait);
		dlog("clone complete files=%d synced=%s", fileCount, sync?.synced);
		return { url: storedUrl, files: fileCount, sync };
	} finally {
		await safeShutdown(repo);
	}
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
 * file on disk. Online: fetches the doc from the sync server. `destPath`
 * (relative to the repo root) overrides where it lands; if omitted, the
 * doc's own `name` field is used. Detached — the written file is an ordinary
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

	const { repo, backend: resolvedBackend, cleanup } = await openDetachedRepo(
		root,
		backend,
	);
	try {
		// Don't race the socket: find + settle are useless before the handshake.
		await waitForConnection(repo, resolvedBackend);
		const handle = await findBounded<UnixFileEntry>(repo, docUrl as AutomergeUrl);
		await waitForSync(handle as DocHandle<unknown>, { idleMs: 1500, maxMs: 15000 });
		const { bytes, entry } = readFileEntry(handle as DocHandle<unknown>);

		const rel = destPath ?? entry.name;
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
 * is last-writer-wins). Online: publishes the change to the sync server so
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
		// Don't race the socket: the catch-up and confirmation below are
		// meaningless before the handshake completes.
		await waitForConnection(repo, resolvedBackend);
		const handle = await findBounded<UnixFileEntry>(
			repo,
			stripHeads(docUrl as AutomergeUrl),
		);
		// Catch up to the server before overwriting, then confirm our write made
		// it back to the server.
		await waitForServerSync(repo, handle as DocHandle<unknown>, resolvedBackend, {
			idleMs: 1500,
			maxMs: 15000,
		});
		applyFileEntry(handle, fresh);
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
	opts: {
		nuclear?: boolean;
		onConfirmStalled?: (unconfirmed: number, total: number) => Promise<boolean>;
		onConfirmProgress?: (confirmed: number, total: number) => void;
	} = {},
	report: Reporter = noReport,
	warn: Warn = noWarn,
): Promise<SyncSnapshot | undefined> {
	if (opts.nuclear) {
		report("Recreating documents");
		await nuclearizeRepo(cwd, warn);
		report("Publishing to sync server");
		return await publishCurrentTree(cwd);
	}
	return await commitWorkdir(
		cwd,
		{
			online: true,
			onConfirmStalled: opts.onConfirmStalled,
			onConfirmProgress: opts.onConfirmProgress,
		},
		report,
		warn,
	);
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
export async function nuclearizeRepo(
	cwd: string,
	warn: Warn = noWarn,
): Promise<void> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	dlog("nuclear root=%s rootUrl=%s", root, config.rootUrl);
	const isArtifactPath = await resolveIsArtifact(
		root,
		config.artifactDirectories,
		warn,
	);

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const folderHandle = await repo.find<unknown>(config.rootUrl);

		const title = path.basename(root) || undefined;
		const oldTree = await shape.decode({ repo, root: folderHandle });

		// For each leaf: read content, create a fresh UnixFileEntry doc.
		const newTree = newDir();
		for (const [posixPath, fileUrl] of flattenLeaves(oldTree)) {
			const bare = stripHeads(fileUrl);
			const oldFileHandle = await repo.find<UnixFileEntry>(bare);
			const oldDoc = oldFileHandle.doc();
			const newFileHandle = repo.create<UnixFileEntry>({
				"@patchwork": { type: "file" },
				name: oldDoc.name,
				extension: oldDoc.extension,
				mimeType: oldDoc.mimeType,
				content: oldDoc.content,
			});
			let finalUrl: AutomergeUrl = newFileHandle.url;
			if (isArtifactPath(posixPath)) {
				finalUrl = pinUrl(newFileHandle);
			}
			setFileAt(newTree, posixPath.split("/").filter(Boolean), finalUrl);
		}

		// Mutate the existing folder doc in place — same URL, new file leaves.
		await shape.encode({
			repo,
			tree: newTree,
			previousRoot: folderHandle,
			title,
			isArtifactDir: isArtifactPath,
		});
	} finally {
		await safeShutdown(repo);
	}
}

export async function save(
	cwd: string,
	report: Reporter = noReport,
	warn: Warn = noWarn,
): Promise<void> {
	await commitWorkdir(cwd, { online: false }, report, warn);
}

async function commitWorkdir(
	cwd: string,
	{
		online,
		onConfirmStalled,
		onConfirmProgress,
	}: {
		online: boolean;
		onConfirmStalled?: (unconfirmed: number, total: number) => Promise<boolean>;
		onConfirmProgress?: (confirmed: number, total: number) => void;
	},
	report: Reporter = noReport,
	warn: Warn = noWarn,
): Promise<SyncSnapshot | undefined> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	dlog("commit online=%s root=%s", online, root);
	const isArtifactPath = await resolveIsArtifact(
		root,
		config.artifactDirectories,
		warn,
	);

	const repo = await openRepo(config.backend, storageDir(root), {
		offline: !online,
	});
	const connWait = online ? waitForConnection(repo, config.backend) : undefined;
	try {
		const shape = await resolveShape(config.shape);
		const folderHandle = await repo.find<unknown>(config.rootUrl);

		const previousTree = await shape.decode({ repo, root: folderHandle });
		const previousFiles = await readFileBytes(repo, previousTree);

		const ig = await loadIgnore(root);
		report("Scanning working tree");
		const fsFiles = await walkDir(root, ig);

		report(online ? "Committing local changes" : "Writing documents");
		const { tree: newTree, changedUrls } = await pushFiles(
			repo,
			fsFiles,
			previousFiles,
			isArtifactPath,
		);
		const changed = !sameTree(previousTree, newTree);
		dlog("commit tree changed: %s", changed);
		const folderDocUrls: AutomergeUrl[] = [];
		if (changed) {
			await shape.encode({
				repo,
				tree: newTree,
				previousRoot: folderHandle,
				isArtifactDir: isArtifactPath,
				onDocChanged: (u) => folderDocUrls.push(u),
			});
		}

		let sync: SyncSnapshot | undefined;
		if (online) {
			report("Syncing with peers");
			// Only artifact (pinned) leaves need a pre-refresh catch-up (to pin to
			// the server's merged heads). No artifacts → the single confirm-wait
			// below both pulls peer changes and pushes our stamp.
			const hasArtifacts = [...flattenLeaves(newTree).keys()].some(isArtifactPath);

			let refreshed = false;
			if (hasArtifacts) {
				// Catch up so the re-pin captures each file doc's post-merge heads.
				await waitForServerSync(repo, folderHandle, config.backend, {
					idleMs: 1500,
					maxMs: 15000,
				});
				// Bare URLs already track current heads implicitly; only pins move.
				refreshed = await refreshFolderPins(
					repo,
					folderHandle,
					shape,
					isArtifactPath,
				);
			}

			// Always stamp lastSyncAt — a sync is also a checkpoint that
			// "we reconciled with the server at this time" — then confirm the
			// server has caught up to the stamped (and any refreshed) state.
			stampLastSyncAt(folderHandle);
			// Confirm changed leaf AND intermediate folder docs alongside the root
			// doc — peers resolve the tree against the server, so all must land.
			const leafConfirm = confirmDocs(
				repo,
				[
					...changedUrls,
					...folderDocUrls.filter((u) => u !== config.rootUrl),
				],
				config.backend,
				connWait,
				{
					onProgress:
						onConfirmProgress ??
						((confirmed, total) =>
							report(`Confirming delivery (${confirmed}/${total})`)),
					onStalled: onConfirmStalled,
				},
			);
			sync = await waitForServerSync(repo, folderHandle, config.backend, {
				idleMs: 1500,
				maxMs: refreshed ? 10000 : hasArtifacts ? 5000 : 15000,
			});
			sync = degradeUnconfirmed(sync, await leafConfirm);
		}

		if (online) report("Writing changes");
		const finalTree = await shape.decode({ repo, root: folderHandle });
		await materializeTree(repo, root, finalTree);
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
		const folderHandle = await repo.find<unknown>(config.rootUrl);
		const tree = await shape.decode({ repo, root: folderHandle });

		const out: HeadsEntry[] = [];
		const matches = (p: string) => matchesPathspec(p, pathspec);

		if (matches("/")) {
			out.push({
				path: "/",
				url: config.rootUrl,
				heads: folderHandle.heads() ?? [],
			});
		}

		for (const [posixPath, fileUrl] of flattenLeaves(tree)) {
			if (!matches(posixPath)) continue;
			const handle = await repo.find<UnixFileEntry>(fileUrl);
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

export async function status(cwd: string): Promise<{ diff: Diff }> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const folderHandle = await repo.find<unknown>(config.rootUrl);
		const previousTree = await shape.decode({ repo, root: folderHandle });
		const previousFiles = await readFileBytes(repo, previousTree);

		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);

		const diff = computeDiff(previousFiles, fsFiles);
		return { diff };
	} finally {
		await safeShutdown(repo);
	}
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
		const folderHandle = await repo.find<unknown>(config.rootUrl);
		const previousTree = await shape.decode({ repo, root: folderHandle });
		const previousFiles = await readFileBytes(repo, previousTree);

		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);

		const out: Array<{ path: string; kind: "added" | "modified" | "deleted"; before?: Uint8Array; after?: Uint8Array }> = [];
		for (const [p, bytes] of fsFiles) {
			if (limitToPath && p !== limitToPath) continue;
			const prev = previousFiles.get(p);
			if (!prev) {
				out.push({ path: p, kind: "added", after: bytes });
			} else if (!byteEq(prev.bytes, bytes)) {
				out.push({ path: p, kind: "modified", before: prev.bytes, after: bytes });
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
		const folderHandle = await repo.find<unknown>(config.rootUrl);
		const previousTree = await shape.decode({ repo, root: folderHandle });
		const previousFiles = await readFileBytes(repo, previousTree);

		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);

		const entries: SnarfEntry[] = [];
		for (const [p, bytes] of fsFiles) {
			const prev = previousFiles.get(p);
			if (!prev) {
				entries.push({ path: p, kind: "added", contentBase64: encodeBytes(bytes) });
			} else if (!byteEq(prev.bytes, bytes)) {
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
		await materializeTree(repo, root, previousTree);
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
		const folderHandle = await repo.find<unknown>(config.rootUrl);
		const previousTree = await shape.decode({ repo, root: folderHandle });
		const previousFiles = await readFileBytes(repo, previousTree);
		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);
		const dirty = computeDiff(previousFiles, fsFiles);
		if (dirty.added.length || dirty.modified.length || dirty.deleted.length) {
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

function computeDiff(
	previous: Map<string, { url: AutomergeUrl; bytes: Uint8Array }>,
	current: Map<string, Uint8Array>,
): Diff {
	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];
	for (const [p, bytes] of current) {
		const prev = previous.get(p);
		if (!prev) added.push(p);
		else if (!byteEq(prev.bytes, bytes)) modified.push(p);
	}
	for (const p of previous.keys()) {
		if (!current.has(p)) deleted.push(p);
	}
	added.sort();
	modified.sort();
	deleted.sort();
	return { added, modified, deleted };
}

async function pushFiles(
	repo: Repo,
	fsFiles: Map<string, Uint8Array>,
	previous: Map<string, { url: AutomergeUrl; bytes: Uint8Array }> | undefined,
	isArtifactPath: IsArtifact,
): Promise<{ tree: VfsNode; changedUrls: AutomergeUrl[] }> {
	const root = newDir();
	const changedUrls: AutomergeUrl[] = [];
	let created = 0;
	let updated = 0;
	let unchanged = 0;
	for (const [posixPath, bytes] of fsFiles) {
		const segments = posixPath.split("/").filter(Boolean);
		const isArtifact = isArtifactPath(posixPath);
		const fresh = makeFileEntry(posixPath, bytes, isArtifact);
		const prev = previous?.get(posixPath);

		let baseUrl: AutomergeUrl;
		if (prev && byteEq(prev.bytes, bytes)) {
			// Unchanged path: keep the existing file-doc URL. For artifacts
			// we'll re-pin from the current heads below.
			baseUrl = stripHeads(prev.url);
			unchanged++;
		} else if (prev) {
			// Changed path: mutate the existing file doc in place (see
			// applyFileEntry). This keeps the file URL stable across edits and
			// avoids the propagation race where a brand-new file doc URL is
			// referenced by the folder before its bytes have reached the server.
			const refreshUrl = stripHeads(prev.url);
			const handle = await repo.find<UnixFileEntry>(refreshUrl);
			applyFileEntry(handle, fresh);
			baseUrl = refreshUrl;
			changedUrls.push(refreshUrl);
			updated++;
			dlog("pushFiles updated %s url=%s artifact=%s bytes=%d", posixPath, baseUrl, isArtifact, bytes.length);
		} else {
			// New path: create a fresh file doc.
			const handle = repo.create<UnixFileEntry>(fresh);
			baseUrl = handle.url;
			changedUrls.push(handle.url);
			created++;
			dlog("pushFiles created %s url=%s artifact=%s bytes=%d", posixPath, baseUrl, isArtifact, bytes.length);
		}

		const finalUrl = isArtifact
			? pinUrl(await repo.find<UnixFileEntry>(baseUrl))
			: baseUrl;
		setFileAt(root, segments, finalUrl);
	}
	dlog("pushFiles done: %d created, %d updated, %d unchanged", created, updated, unchanged);
	return { tree: root, changedUrls };
}



/**
 * Fold the leaf/folder confirmation result into the root verdict: a SYNCED
 * root with unconfirmed children is not synced — report PENDING (with the
 * in-flight count carried on the snapshot for display) instead of silently
 * declaring victory with docs peers would still see as "unavailable".
 */
function degradeUnconfirmed(
	sync: SyncSnapshot | undefined,
	{ unconfirmed }: { unconfirmed: number },
): SyncSnapshot | undefined {
	if (unconfirmed === 0 || !sync) return sync;
	// Disconnected: OFFLINE already tells the story — don't relabel it PENDING.
	if (!sync.connected) return sync;
	return { ...sync, synced: false, pending: true, unconfirmed };
}

/**
 * Push-confirm each changed file doc with the server, not just the folder
 * doc. Without this, freshly created/updated leaf docs ride solely on the
 * shutdown quiesce; on a slow link the process can exit before they land,
 * leaving the folder entry pointing at a doc the server never received
 * (the clone-unavailable / propagation flake family). Callers pass only the
 * docs changed this run — the server may not have advertised heads for
 * untouched docs, and waiting on those would burn the whole budget.
 */
async function confirmDocs(
	repo: Repo,
	urls: readonly AutomergeUrl[],
	backend: Backend,
	connWait: Promise<Connection> | undefined,
	{
		onProgress,
		onStalled,
	}: {
		onProgress?: (confirmed: number, total: number) => void;
		onStalled?: (unconfirmed: number, total: number) => Promise<boolean>;
	} = {},
): Promise<{ unconfirmed: number }> {
	const unique = [...new Set(urls)];
	if (unique.length === 0) return { unconfirmed: 0 };
	// No confirmation is possible without a server; don't burn any budget
	// (e.g. init against an unreachable server must still finish promptly).
	if (connWait && !(await connWait).connected) {
		return { unconfirmed: unique.length };
	}
	const handles = await Promise.all(
		unique.map((url) => repo.find<unknown>(stripHeads(url))),
	);
	return confirmDelivery(repo, handles, backend, { onProgress, onStalled });
}

/**
 * Re-pin every artifact leaf in the folder doc to its file doc's current
 * heads. Bare (non-artifact) URLs are left as-is since they already track
 * current heads implicitly. Returns true if any leaf URL was rewritten.
 */
async function refreshFolderPins(
	repo: Repo,
	folderHandle: DocHandle<unknown>,
	shape: Shape,
	isArtifactPath: IsArtifact,
): Promise<boolean> {
	const tree = await shape.decode({ repo, root: folderHandle });
	const refreshed = newDir();
	let changed = false;
	for (const [posixPath, currentUrl] of flattenLeaves(tree)) {
		const segments = posixPath.split("/").filter(Boolean);
		let finalUrl: AutomergeUrl = currentUrl;
		if (isArtifactPath(posixPath)) {
			const handle = await repo.find<UnixFileEntry>(stripHeads(currentUrl));
			const repinned = pinUrl(handle);
			if (repinned !== currentUrl) {
				finalUrl = repinned;
				changed = true;
			}
		}
		setFileAt(refreshed, segments, finalUrl);
	}
	if (changed) {
		dlog("refreshFolderPins: re-pinned artifacts to current heads");
		await shape.encode({
			repo,
			tree: refreshed,
			previousRoot: folderHandle,
			isArtifactDir: isArtifactPath,
		});
	}
	return changed;
}

async function readFileBytes(
	repo: Repo,
	tree: VfsNode,
): Promise<Map<string, { url: AutomergeUrl; bytes: Uint8Array }>> {
	const out = new Map<string, { url: AutomergeUrl; bytes: Uint8Array }>();
	for (const [posixPath, fileUrl] of flattenLeaves(tree)) {
		// Possibly remote (a peer's new doc arriving via sync): bound the fetch.
		const handle = await findBounded<UnixFileEntry>(repo, fileUrl);
		out.set(posixPath, {
			url: fileUrl,
			bytes: contentToBytes(handle.doc().content),
		});
	}
	return out;
}

async function materializeTree(
	repo: Repo,
	root: string,
	tree: VfsNode,
): Promise<void> {
	const leaves = flattenLeaves(tree);

	// Fetch all leaves concurrently: a single Subduction connection
	// multiplexes concurrent `repo.find`s, so per-doc sync round-trips overlap
	// instead of serializing (benched vs serial and vs the old worker pool in
	// ADR-031/032). The transport's own receive-credit windowing is the
	// backpressure; no artificial cap here.
	const desired = new Map<string, Uint8Array>();
	await Promise.all(
		[...leaves].map(async ([posixPath, fileUrl]) => {
			const handle = await findBounded<UnixFileEntry>(repo, fileUrl);
			desired.set(posixPath, contentToBytes(handle.doc().content));
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

	let written = 0;
	let removed = 0;
	for (const [posixPath, bytes] of desired) {
		if (byteEq(present.get(posixPath), bytes)) continue;
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

function sameTree(a: VfsNode, b: VfsNode): boolean {
	const av = flattenLeaves(a);
	const bv = flattenLeaves(b);
	if (av.size !== bv.size) return false;
	for (const [k, v] of av) {
		if (bv.get(k) !== v) return false;
	}
	return true;
}

export type { Shape, UnixFileEntry, VfsNode, PushworkConfig };
