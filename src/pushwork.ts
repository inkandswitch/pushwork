import * as fs from "fs/promises";
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
import { byteEq, walkDir, writeFileAtomic } from "./fs-tree.js";
import { shardClone, shardIngest, shouldShard } from "./ingest-pool.js";
import { log } from "./log.js";
import { openRepo, waitForSync } from "./repo.js";
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
	contentEquals,
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

export type InitOpts = {
	dir: string;
	backend: Backend;
	shape: string;
	artifactDirectories?: readonly string[];
	online?: boolean; // default: true
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

export async function init(opts: InitOpts): Promise<AutomergeUrl> {
	const root = path.resolve(opts.dir);
	const online = opts.online ?? true;
	dlog("init root=%s backend=%s shape=%s online=%s", root, opts.backend, opts.shape, online);
	if (await configExists(root)) {
		throw new Error(`pushwork already initialized at ${root}`);
	}
	const artifactDirs = normalizeDirs(
		opts.artifactDirectories ?? DEFAULT_ARTIFACT_DIRECTORIES,
	);
	dlog("init artifactDirs=%o", artifactDirs);
	await fs.mkdir(pushworkDir(root), { recursive: true });

	const repo = await openRepo(opts.backend, storageDir(root), { offline: !online });
	try {
		const shape = await resolveShape(opts.shape);
		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);
		dlog("init walked %d files", fsFiles.size);

		const title = path.basename(root) || undefined;
		const tree = shouldShard(fsFiles.size)
			? await ingestSharded(repo, root, opts.backend, online, fsFiles, artifactDirs)
			: await pushFiles(repo, fsFiles, undefined, artifactDirs);
		const folderUrl = await shape.encode({ repo, tree, title });
		dlog("init encoded folder=%s title=%s", folderUrl, title);
		const folderHandle = await repo.find<unknown>(folderUrl);

		if (online) {
			await waitForSync(folderHandle, { minMs: 3000, idleMs: 1500, maxMs: 15000 });
			stampLastSyncAt(folderHandle);
			await waitForSync(folderHandle, { idleMs: 1500, maxMs: 10000 });
		}

		await writeConfig(root, {
			version: CONFIG_VERSION,
			rootUrl: folderUrl,
			backend: opts.backend,
			shape: opts.shape,
			artifactDirectories: artifactDirs,
		});
		dlog("init complete: rootUrl=%s", folderUrl);
		return folderUrl;
	} finally {
		await repo.shutdown();
	}
}

export async function clone(opts: CloneOpts): Promise<void> {
	if (!isValidAutomergeUrl(opts.url)) {
		throw new Error(`invalid automerge URL: ${opts.url}`);
	}
	const root = path.resolve(opts.dir);
	dlog("clone url=%s root=%s backend=%s shape=%s", opts.url, root, opts.backend, opts.shape);
	await fs.mkdir(root, { recursive: true });
	if (await configExists(root)) {
		throw new Error(`pushwork already initialized at ${root}`);
	}
	const artifactDirs = normalizeDirs(
		opts.artifactDirectories ?? DEFAULT_ARTIFACT_DIRECTORIES,
	);
	await fs.mkdir(pushworkDir(root), { recursive: true });

	const online = opts.online ?? true;
	const repo = await openRepo(opts.backend, storageDir(root), { offline: !online });
	try {
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

		const { shape, shapeName } = await resolveCloneShape({
			opts,
			repo,
			root,
			online,
			folderHandle,
		});

		const tree = await shape.decode({ repo, root: folderHandle });
		await materializeTree(repo, root, tree, { backend: opts.backend, online });

		await writeConfig(root, {
			version: CONFIG_VERSION,
			rootUrl: storedUrl,
			backend: opts.backend,
			shape: shapeName,
			artifactDirectories: artifactDirs,
		});
		dlog("clone complete");
	} finally {
		await repo.shutdown();
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

export async function sync(
	cwd: string,
	opts: { nuclear?: boolean } = {},
): Promise<void> {
	if (opts.nuclear) {
		await nuclearizeRepo(cwd);
		await publishCurrentTree(cwd);
		return;
	}
	await commitWorkdir(cwd, { online: true });
}

/**
 * Open an online repo, subscribe the root folder and every file leaf so the
 * network adapter announces them to peers, then wait for the local heads to
 * settle. No decode/diff/encode — used after nuclearizeRepo, where every doc
 * is freshly created locally and the server has nothing to merge in.
 */
async function publishCurrentTree(cwd: string): Promise<void> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	dlog("publish root=%s", root);

	const repo = await openRepo(config.backend, storageDir(root), { offline: false });
	try {
		const shape = await resolveShape(config.shape);
		const folderHandle = await repo.find<unknown>(config.rootUrl);
		const tree = await shape.decode({ repo, root: folderHandle });
		// Touch every leaf so the network adapter knows to push it.
		for (const [, fileUrl] of flattenLeaves(tree)) {
			await repo.find<UnixFileEntry>(fileUrl);
		}
		stampLastSyncAt(folderHandle);
		await waitForSync(folderHandle, {
			minMs: 3000,
			idleMs: 1500,
			maxMs: 15000,
		});
		dlog("publish complete");
	} finally {
		await repo.shutdown();
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
			if (isInArtifactDir(posixPath, config.artifactDirectories)) {
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
		});
	} finally {
		await repo.shutdown();
	}
}

export async function save(cwd: string): Promise<void> {
	await commitWorkdir(cwd, { online: false });
}

async function commitWorkdir(
	cwd: string,
	{ online }: { online: boolean },
): Promise<void> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	dlog("commit online=%s root=%s", online, root);

	const repo = await openRepo(config.backend, storageDir(root), {
		offline: !online,
	});
	try {
		const shape = await resolveShape(config.shape);
		const folderHandle = await repo.find<unknown>(config.rootUrl);

		const previousTree = await shape.decode({ repo, root: folderHandle });
		const previousFiles = await readFileBytes(repo, previousTree);

		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);

		const newTree = await pushFiles(
			repo,
			fsFiles,
			previousFiles,
			config.artifactDirectories,
		);
		const changed = !sameTree(previousTree, newTree);
		dlog("commit tree changed: %s", changed);
		if (changed) {
			await shape.encode({ repo, tree: newTree, previousRoot: folderHandle });
		}

		if (online) {
			await waitForSync(folderHandle, {
				minMs: 3000,
				idleMs: 1500,
				maxMs: 15000,
			});

			// After peer changes have settled, refresh the folder doc so its
			// pinned (artifact) leaves reference each file doc's current
			// heads. Bare URLs already track current heads implicitly.
			const refreshed = await refreshFolderPins(
				repo,
				folderHandle,
				shape,
				config.artifactDirectories,
			);

			// Always stamp lastSyncAt — a sync is also a checkpoint that
			// "we reconciled with the server at this time" — and let any
			// resulting changes flush.
			stampLastSyncAt(folderHandle);
			await waitForSync(folderHandle, {
				idleMs: 1500,
				maxMs: refreshed ? 10000 : 5000,
			});
		}

		const finalTree = await shape.decode({ repo, root: folderHandle });
		await materializeTree(repo, root, finalTree);
		dlog("commit complete");
	} finally {
		await repo.shutdown();
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
		await repo.shutdown();
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
		await repo.shutdown();
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
		await repo.shutdown();
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
		await repo.shutdown();
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
		await repo.shutdown();
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
	artifactDirs: readonly string[],
): Promise<VfsNode> {
	const root = newDir();
	let created = 0;
	let updated = 0;
	let unchanged = 0;
	for (const [posixPath, bytes] of fsFiles) {
		const segments = posixPath.split("/").filter(Boolean);
		const isArtifact = isInArtifactDir(posixPath, artifactDirs);
		const fresh = makeFileEntry(posixPath, bytes, isArtifact);
		const prev = previous?.get(posixPath);

		let baseUrl: AutomergeUrl;
		if (prev && byteEq(prev.bytes, bytes)) {
			// Unchanged path: keep the existing file-doc URL. For artifacts
			// we'll re-pin from the current heads below.
			baseUrl = stripHeads(prev.url);
			unchanged++;
		} else if (prev) {
			// Changed path: mutate the existing file doc in place. This keeps
			// the file URL stable across edits and avoids the propagation
			// race where a brand-new file doc URL is referenced by the folder
			// before its bytes have reached the sync server.
			//
			// For string content (text files) we use Automerge.updateText so
			// concurrent character-level edits merge correctly. Bytes and
			// ImmutableString are atomic — last writer wins on the field.
			const refreshUrl = stripHeads(prev.url);
			const handle = await repo.find<UnixFileEntry>(refreshUrl);
			handle.change((d: UnixFileEntry) => {
				if (!contentEquals(d.content, fresh.content)) {
					if (
						typeof d.content === "string" &&
						typeof fresh.content === "string"
					) {
						Automerge.updateText(d, ["content"], fresh.content);
					} else {
						d.content = fresh.content;
					}
				}
				if (d.extension !== fresh.extension) d.extension = fresh.extension;
				if (d.mimeType !== fresh.mimeType) d.mimeType = fresh.mimeType;
				if (d.name !== fresh.name) d.name = fresh.name;
				if (!d["@patchwork"]) d["@patchwork"] = { type: "file" };
			});
			baseUrl = refreshUrl;
			updated++;
			dlog("pushFiles updated %s url=%s artifact=%s bytes=%d", posixPath, baseUrl, isArtifact, bytes.length);
		} else {
			// New path: create a fresh file doc.
			const handle = repo.create<UnixFileEntry>(fresh);
			baseUrl = handle.url;
			created++;
			dlog("pushFiles created %s url=%s artifact=%s bytes=%d", posixPath, baseUrl, isArtifact, bytes.length);
		}

		const finalUrl = isArtifact
			? pinUrl(await repo.find<UnixFileEntry>(baseUrl))
			: baseUrl;
		setFileAt(root, segments, finalUrl);
	}
	dlog("pushFiles done: %d created, %d updated, %d unchanged", created, updated, unchanged);
	return root;
}

/**
 * Like `pushFiles` for the all-new case (init), but builds the file documents
 * across the shared-nothing worker pool: workers create + persist (+ upload)
 * their shard and report `{path, url, heads}`; this thread only stitches the
 * URLs into the tree (pinning artifacts from the reported heads) and falls
 * back to main-thread creation for any path a worker could not handle.
 */
async function ingestSharded(
	repo: Repo,
	root: string,
	backend: Backend,
	online: boolean,
	fsFiles: Map<string, Uint8Array>,
	artifactDirs: readonly string[],
): Promise<VfsNode> {
	const { created, failed } = await shardIngest({
		root,
		backend,
		online,
		files: fsFiles,
		artifactDirs,
	});

	const tree = newDir();
	for (const [posixPath, url] of created) {
		setFileAt(tree, posixPath.split("/").filter(Boolean), url);
	}

	for (const posixPath of failed) {
		const bytes = fsFiles.get(posixPath);
		if (!bytes) continue;
		const isArtifact = isInArtifactDir(posixPath, artifactDirs);
		const handle = repo.create<UnixFileEntry>(
			makeFileEntry(posixPath, bytes, isArtifact),
		);
		const url = isArtifact ? pinUrl(handle) : handle.url;
		setFileAt(tree, posixPath.split("/").filter(Boolean), url);
	}

	dlog("ingestSharded created=%d main-fallback=%d", created.size, failed.length);
	return tree;
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
	artifactDirs: readonly string[],
): Promise<boolean> {
	const tree = await shape.decode({ repo, root: folderHandle });
	const refreshed = newDir();
	let changed = false;
	for (const [posixPath, currentUrl] of flattenLeaves(tree)) {
		const segments = posixPath.split("/").filter(Boolean);
		let finalUrl: AutomergeUrl = currentUrl;
		if (isInArtifactDir(posixPath, artifactDirs)) {
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
		await shape.encode({ repo, tree: refreshed, previousRoot: folderHandle });
	}
	return changed;
}

async function readFileBytes(
	repo: Repo,
	tree: VfsNode,
): Promise<Map<string, { url: AutomergeUrl; bytes: Uint8Array }>> {
	const out = new Map<string, { url: AutomergeUrl; bytes: Uint8Array }>();
	for (const [posixPath, fileUrl] of flattenLeaves(tree)) {
		const handle = await repo.find<UnixFileEntry>(fileUrl);
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
	shardCtx?: { backend: Backend; online: boolean },
): Promise<void> {
	const leaves = flattenLeaves(tree);

	// Clone path: fan the per-file download + write out to the worker pool.
	// Only the caller that knows the working tree is freshly materialized
	// (clone) passes shardCtx, so writing every leaf is correct here.
	if (shardCtx && shouldShard(leaves.size)) {
		await materializeSharded(repo, root, leaves, shardCtx);
		return;
	}

	const desired = new Map<string, Uint8Array>();
	for (const [posixPath, fileUrl] of leaves) {
		const handle = await repo.find<UnixFileEntry>(fileUrl);
		desired.set(posixPath, contentToBytes(handle.doc().content));
	}
	dlog("materialize desired: %d files", desired.size);

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

async function materializeSharded(
	repo: Repo,
	root: string,
	leaves: Map<string, AutomergeUrl>,
	shardCtx: { backend: Backend; online: boolean },
): Promise<void> {
	const { written, failed } = await shardClone({
		root,
		backend: shardCtx.backend,
		online: shardCtx.online,
		leaves,
	});

	// Main-thread fallback for any leaf a worker could not write.
	for (const posixPath of failed) {
		const url = leaves.get(posixPath);
		if (!url) continue;
		const handle = await repo.find<UnixFileEntry>(url);
		await writeFileAtomic(
			path.join(root, fromPosix(posixPath)),
			contentToBytes(handle.doc().content),
		);
	}

	// Remove anything on disk the tree no longer references.
	const ig = await loadIgnore(root);
	const present = await walkDir(root, ig);
	let removed = 0;
	for (const posixPath of present.keys()) {
		if (leaves.has(posixPath)) continue;
		try {
			await fs.unlink(path.join(root, fromPosix(posixPath)));
			removed++;
		} catch {
			// already gone
		}
		await pruneEmptyDirs(root, path.dirname(fromPosix(posixPath)));
	}
	dlog(
		"materialize (shard) written=%d main-fallback=%d removed=%d",
		written.size,
		failed.length,
		removed,
	);
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
