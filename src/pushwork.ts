import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { MemoryStorage } from "@automerge/automerge-subduction";
import {
	CONFIG_VERSION,
	configExists,
	pushworkDir,
	readConfig,
	storageDir,
	writeConfig,
	type PushworkConfig,
} from "./config.js";
import { Docs, limiter, type SyncReport } from "./docs.js";
import type { Hive } from "./keyhive.js";
import { loadIgnore } from "./ignore.js";
import { ATTRIBUTES_FILE, readAttributes } from "./attributes.js";
import { byteEq, walkDir, writeFileMkdir, type FileTree } from "./fs-tree.js";
import { loadSeed, signerFrom } from "./key.js";
import { log } from "./log.js";
import { FsStorage } from "./storage.js";
import {
	encodeHeads,
	isProtected,
	isValidAutomergeUrl,
	parseAutomergeUrl,
	stripHeads,
	type AutomergeUrl,
} from "./url.js";
import {
	appendSnarf,
	decodeBytes,
	encodeBytes,
	listSnarfs,
	takeSnarf,
	type Snarf,
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
	readFileEntry,
	resolveShape,
	setFileAt,
	vfsShape,
	type Shape,
	type UnixFileEntry,
	type VfsNode,
} from "./shapes/index.js";
import { loadCustomShape } from "./shapes/custom.js";

const dlog = log("pushwork");

export const DEFAULT_SERVER = "wss://subduction.sync.inkandswitch.com";

const DEFAULT_ARTIFACT_DIRECTORIES = ["dist"];

/** Called at phase boundaries of long operations so the CLI can show progress. */
export type Reporter = (phase: string) => void;
const noReport: Reporter = () => {};

/** Surfaces a non-fatal warning to the user. */
export type Warn = (message: string) => void;
const noWarn: Warn = () => {};

/** Whether a repo-relative posix path is an artifact (immutable, heads-pinned). */
type IsArtifact = (posixPath: string) => boolean;

type Files = Map<string, { url: AutomergeUrl; bytes: Uint8Array }>;

/** The server's verdict plus the root doc's heads (bs58check, as in URLs). */
export type SyncSummary = SyncReport & { url: AutomergeUrl; heads: string[] };

export type RepoSummary = {
	url: AutomergeUrl;
	files: number;
	sync: SyncSummary;
};

export type InitOpts = {
	dir: string;
	shape: string;
	artifactDirectories?: readonly string[];
	online?: boolean; // default: true
	server?: string;
	publish?: boolean;
};

export type CloneOpts = {
	url: string;
	dir: string;
	shape: string;
	artifactDirectories?: readonly string[];
	server?: string;
	// Asked whether to download and run the root doc's `.pushworkStrategy` as a
	// custom shape. Returning false (or omitting it) falls back to `shape`.
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

export type Change = {
	path: string;
	kind: "added" | "modified" | "deleted";
	before?: Uint8Array;
	after?: Uint8Array;
};

async function openDocs(
	root: string,
	seed: Uint8Array,
	server?: string,
	hive?: Hive,
	group?: string,
): Promise<Docs> {
	return Docs.open({
		storage: await FsStorage.open(storageDir(root)),
		signer: signerFrom(seed),
		server,
		codec: hive?.codec,
		newId: group ? hive!.newId(group) : undefined,
	});
}

const isPublished = (url: AutomergeUrl) => isProtected(parseAutomergeUrl(url).documentId);

// Published repos are encrypted with keyhive and sync through the one server that speaks it.
// ARK is loaded only here, so plain repos never pay for it. The archive is per user, like
// the key: keyhive breaks when one identity starts over in a fresh archive.
async function openHive(seed: Uint8Array, server?: string, reader = false): Promise<Hive> {
	const { openHive } = await import("./keyhive.js");
	const hive = await openHive(path.join(os.homedir(), ".pushwork", "keyhive"), seed, reader);
	if (server && server !== hive.server) {
		throw new Error(`published repos sync through ${hive.server} only`);
	}
	return hive;
}

// a reader (status, diff, cut...) changes no docs, so it leaves the keyhive archive alone
async function openRepo(cwd: string, { online = false, reader = false } = {}) {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	const seed = await loadSeed();
	const hive = isPublished(config.rootUrl) ? await openHive(seed, config.server, reader) : undefined;
	const server = online ? (hive?.server ?? config.server ?? DEFAULT_SERVER) : undefined;
	const docs = await openDocs(root, seed, server, hive, config.publishGroup);
	return { root, config, docs, hive };
}

// Only the publisher writes a published repo; everyone else pulls.
const canWrite = async (config: PushworkConfig, hive?: Hive) =>
	!hive ||
	(config.publishGroup !== undefined &&
		(await hive.canWrite(parseAutomergeUrl(config.rootUrl).documentId)));

// The server drops docs whose keyhive membership it hasn't seen, so that goes first.
async function syncAll(docs: Docs, hive?: Hive): Promise<void> {
	if (hive && docs.online) {
		await docs.save();
		await hive.sync(docs);
	}
	await docs.sync();
}

// The tree as last saved, with every file's bytes. Offline; the caller calls close.
async function loadSavedTree(cwd: string) {
	const { root, config, docs, hive } = await openRepo(cwd, { reader: true });
	const close = async () => {
		await docs.close();
		await hive?.close();
	};
	try {
		const shape = await resolveShape(config.shape);
		const tree = await shape.decode({ docs, root: config.rootUrl });
		const files = await readFileBytes(docs, tree);
		return { root, config, docs, shape, tree, files, close };
	} catch (e) {
		await close();
		throw e;
	}
}

async function summarize(docs: Docs, url: AutomergeUrl): Promise<SyncSummary> {
	return { ...docs.report(), url, heads: encodeHeads(await docs.heads(url)) };
}

// A `.pushworkattributes` with artifact rules wins over config.json's artifactDirectories.
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
		return (p) => attrs.isArtifact(p);
	}
	return (p) => isInArtifactDir(p, configDirs);
}

export async function init(
	opts: InitOpts,
	report: Reporter = noReport,
	warn: Warn = noWarn,
): Promise<RepoSummary> {
	const root = path.resolve(opts.dir);
	const online = opts.online ?? true;
	dlog("init root=%s shape=%s online=%s", root, opts.shape, online);
	if (await configExists(root)) {
		throw new Error(`pushwork already initialized at ${root}`);
	}
	if (opts.publish && opts.server) throw new Error("--publish can't be used with --server");
	// An existing `.pushworkattributes` is authoritative; keep config.json's list empty.
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
	const isArtifact: IsArtifact = attrs?.hasArtifactRules
		? (p) => attrs.isArtifact(p)
		: (p) => isInArtifactDir(p, artifactDirs);

	const seed = await loadSeed();
	const hive = opts.publish ? await openHive(seed) : undefined;
	const group = await hive?.createPublicGroup();
	const server = online ? (hive?.server ?? opts.server ?? DEFAULT_SERVER) : undefined;
	const docs = await openDocs(root, seed, server, hive, group);
	try {
		const shape = await resolveShape(opts.shape);
		report("Reading working tree");
		const fsFiles = await walk(root);
		report(`Encoding ${plural(fsFiles.size, "file")}`);
		const tree = await pushFiles(docs, fsFiles, undefined, isArtifact);
		const url = await shape.encode({
			docs,
			tree,
			title: path.basename(root) || undefined,
			isArtifactDir: isArtifact,
		});
		dlog("init root doc %s", url);
		if (docs.online) report(`Publishing ${plural(fsFiles.size, "file")} to the sync server`);
		await syncAll(docs, hive);
		await writeConfig(root, {
			version: CONFIG_VERSION,
			rootUrl: url,
			shape: opts.shape,
			artifactDirectories: artifactDirs,
			...(opts.server ? { server: opts.server } : {}),
			...(group ? { publishGroup: group } : {}),
		});
		return { url, files: fsFiles.size, sync: await summarize(docs, url) };
	} finally {
		await docs.close();
		await hive?.close();
	}
}

export async function clone(
	opts: CloneOpts,
	report: Reporter = noReport,
): Promise<RepoSummary> {
	if (!isValidAutomergeUrl(opts.url)) {
		throw new Error(`invalid automerge URL: ${opts.url}`);
	}
	const url = stripHeads(opts.url);
	const root = path.resolve(opts.dir);
	dlog("clone url=%s root=%s shape=%s", url, root, opts.shape);
	if (await configExists(root)) {
		throw new Error(`pushwork already initialized at ${root}`);
	}
	await fs.mkdir(pushworkDir(root), { recursive: true });

	const seed = await loadSeed();
	const hive = isPublished(url) ? await openHive(seed, opts.server) : undefined;
	const server = hive?.server ?? opts.server ?? DEFAULT_SERVER;
	const docs = await openDocs(root, seed, server, hive);
	try {
		if (!docs.online) {
			throw new Error(`could not connect to ${server}: ${docs.report().error}`);
		}
		report("Fetching repository");
		await hive?.sync(docs);
		const { shape, shapeName } = await resolveCloneShape(docs, url, root, opts);
		const tree = await shape.decode({ docs, root: url });
		const files = flattenLeaves(tree).size;
		report(`Downloading ${plural(files, "file")}`);
		await materializeTree(docs, root, tree);

		// If the repo carries its own artifact attributes, config.json defers to them.
		const attrs = await readAttributes(root);
		const artifactDirs = attrs?.hasArtifactRules
			? []
			: normalizeDirs(opts.artifactDirectories ?? DEFAULT_ARTIFACT_DIRECTORIES);
		await writeConfig(root, {
			version: CONFIG_VERSION,
			rootUrl: url,
			shape: shapeName,
			artifactDirectories: artifactDirs,
			...(opts.server ? { server: opts.server } : {}),
		});
		return { url, files, sync: await summarize(docs, url) };
	} finally {
		await docs.close();
		await hive?.close();
	}
}

type RootDoc = {
	"@patchwork"?: { type?: unknown };
	".pushworkStrategy"?: unknown;
};

// @patchwork.type picks a builtin shape; otherwise a `.pushworkStrategy` may be
// downloaded and run (with consent); otherwise opts.shape.
async function resolveCloneShape(
	docs: Docs,
	url: AutomergeUrl,
	root: string,
	opts: CloneOpts,
): Promise<{ shape: Shape; shapeName: string }> {
	const doc = await docs.find<RootDoc>(url);
	const type = doc["@patchwork"]?.type;
	if (type === "directory") return { shape: vfsShape, shapeName: "vfs" };
	if (type === "folder") return { shape: patchworkFolderShape, shapeName: "patchwork-folder" };

	const strategy = doc[".pushworkStrategy"];
	if (isValidAutomergeUrl(strategy)) {
		if (!opts.onStrategyDoc) {
			throw new Error(
				`root doc has no recognized @patchwork.type and declares a .pushworkStrategy (${strategy}); refusing to run it without confirmation. Pass --shape explicitly.`,
			);
		}
		const { bytes } = readFileEntry(await docs.find(strategy));
		const code = new TextDecoder().decode(bytes);
		if (await opts.onStrategyDoc({ url: strategy, viewCode: () => code })) {
			const dest = path.join(pushworkDir(root), "strategy.mjs");
			await fs.writeFile(dest, code, "utf8");
			return { shape: await loadCustomShape(dest), shapeName: path.relative(root, dest) };
		}
	}
	return { shape: await resolveShape(opts.shape), shapeName: opts.shape };
}

export async function url(cwd: string): Promise<AutomergeUrl> {
	const config = await readConfig(path.resolve(cwd));
	return config.rootUrl;
}

// Inside a repo, yoink/yeet use its server but not its storage: a doc the repo tracks
// that changed underneath it would look like a local edit to its next sync and be undone.
async function openDetached(root: string, url: AutomergeUrl, server?: string): Promise<Docs> {
	if (isPublished(url)) throw new Error("yoink and yeet don't support published docs");
	const config = (await configExists(root)) ? await readConfig(root) : undefined;
	return Docs.open({
		storage: new MemoryStorage(),
		signer: signerFrom(await loadSeed()),
		server: server ?? config?.server ?? DEFAULT_SERVER,
	});
}

/**
 * Fetch one file doc and write its content to `destPath` (default: the doc's
 * own name). The written file is not linked to the doc.
 */
export async function yoink(
	cwd: string,
	docUrl: string,
	destPath?: string,
	server?: string,
): Promise<{ path: string; bytes: number; url: AutomergeUrl }> {
	if (!isValidAutomergeUrl(docUrl)) {
		throw new Error(`invalid automerge URL: ${docUrl}`);
	}
	const root = path.resolve(cwd);
	const docs = await openDetached(root, docUrl, server);
	try {
		await docs.sync([stripHeads(docUrl)]);
		const { bytes, entry } = readFileEntry(await docs.find(docUrl));
		const rel = destPath ?? entry.name;
		if (!rel) throw new Error(`doc ${docUrl} has no name field; pass a destination path`);
		const target = path.resolve(root, fromPosix(rel));
		if (!target.startsWith(root + path.sep)) {
			throw new Error(`destination escapes the repo: ${rel}`);
		}
		await writeFileMkdir(target, bytes);
		return { path: path.relative(root, target), bytes: bytes.length, url: docUrl };
	} finally {
		await docs.close();
	}
}

/** Write one file from disk into the file doc at `docUrl`, in place, and push it. */
export async function yeet(
	cwd: string,
	srcPath: string,
	docUrl: string,
	server?: string,
): Promise<{ path: string; bytes: number; url: AutomergeUrl; sync: SyncReport }> {
	if (!isValidAutomergeUrl(docUrl)) {
		throw new Error(`invalid automerge URL: ${docUrl}`);
	}
	const root = path.resolve(cwd);
	const bytes = new Uint8Array(await fs.readFile(path.resolve(root, fromPosix(srcPath))));
	const fresh = makeFileEntry(srcPath.split(path.sep).join("/"), bytes, false);
	const bare = stripHeads(docUrl);
	const docs = await openDetached(root, bare, server);
	try {
		await docs.sync([bare]);
		await docs.change<UnixFileEntry>(bare, (d) => applyFileEntry(d, fresh));
		const sync = await docs.sync([bare]);
		return { path: srcPath, bytes: bytes.length, url: bare, sync };
	} finally {
		await docs.close();
	}
}

export async function sync(
	cwd: string,
	opts: { nuclear?: boolean } = {},
	report: Reporter = noReport,
	warn: Warn = noWarn,
): Promise<SyncSummary> {
	if (!opts.nuclear) return commitWorkdir(cwd, true, report, warn);
	const { root, config, docs, hive } = await openRepo(cwd, { online: true });
	try {
		report("Recreating documents");
		await nuclearize(docs, root, config, hive, warn);
		if (docs.online) report("Publishing to sync server");
		await syncAll(docs, hive);
		return await summarize(docs, config.rootUrl);
	} finally {
		await docs.close();
		await hive?.close();
	}
}

/**
 * Point the root doc (same URL) at freshly created copies of every file doc.
 * Anyone holding an old file URL keeps it; this repo stops referencing it.
 */
export async function nuclearizeRepo(cwd: string, warn: Warn = noWarn): Promise<void> {
	const { root, config, docs, hive } = await openRepo(cwd);
	try {
		await nuclearize(docs, root, config, hive, warn);
	} finally {
		await docs.close();
		await hive?.close();
	}
}

async function nuclearize(docs: Docs, root: string, config: PushworkConfig, hive: Hive | undefined, warn: Warn) {
	if (!(await canWrite(config, hive))) throw new Error("read-only repo");
	const isArtifact = await resolveIsArtifact(root, config.artifactDirectories, warn);
	const shape = await resolveShape(config.shape);
	const oldTree = await shape.decode({ docs, root: config.rootUrl });
	const tree = newDir();
	for (const [posixPath, fileUrl] of flattenLeaves(oldTree)) {
		const old = await docs.find<UnixFileEntry>(stripHeads(fileUrl));
		const url = await docs.create<UnixFileEntry>({
			"@patchwork": { type: "file" },
			name: old.name,
			extension: old.extension,
			mimeType: old.mimeType,
			content: old.content,
		});
		setFileAt(tree, posixPath.split("/"), isArtifact(posixPath) ? await docs.pin(url) : url);
	}
	await shape.encode({
		docs,
		tree,
		previousRoot: config.rootUrl,
		title: path.basename(root) || undefined,
		isArtifactDir: isArtifact,
	});
}

export async function save(
	cwd: string,
	report: Reporter = noReport,
	warn: Warn = noWarn,
): Promise<void> {
	await commitWorkdir(cwd, false, report, warn);
}

async function commitWorkdir(
	cwd: string,
	online: boolean,
	report: Reporter,
	warn: Warn,
): Promise<SyncSummary> {
	const { root, config, docs, hive } = await openRepo(cwd, { online });
	dlog("commit online=%s root=%s", online, root);
	try {
		const isArtifact = await resolveIsArtifact(root, config.artifactDirectories, warn);
		const shape = await resolveShape(config.shape);
		const rootUrl = config.rootUrl;

		// diff against the last local state, not the server's
		const prevTree = await shape.decode({ docs, root: rootUrl });
		const prevFiles = await readFileBytes(docs, prevTree);
		report("Scanning working tree");
		const fsFiles = await walk(root);
		const writable = await canWrite(config, hive);
		let tree = prevTree;
		if (writable) {
			report(online ? "Committing local changes" : "Writing documents");
			tree = await pushFiles(docs, fsFiles, prevFiles, isArtifact);
			if (!sameTree(prevTree, tree)) {
				await shape.encode({ docs, tree, previousRoot: rootUrl, isArtifactDir: isArtifact });
			}
		} else if (changes(prevFiles, fsFiles).length) {
			throw new Error("read-only repo; `pushwork cut` your changes first");
		}

		if (docs.online) {
			report("Syncing with server");
			await syncAll(docs, hive);
			if (writable && [...flattenLeaves(tree).keys()].some(isArtifact)) {
				const moved = await refreshPins(docs, rootUrl, shape, isArtifact);
				if (moved.length) await docs.sync(moved);
			}
			report("Writing changes");
		}
		await materializeTree(docs, root, await shape.decode({ docs, root: rootUrl }));
		return await summarize(docs, rootUrl);
	} finally {
		await docs.close();
		await hive?.close();
	}
}

export type HeadsEntry = {
	path: string; // "/" for the root doc, posix file path otherwise
	url: AutomergeUrl;
	heads: string[];
};

/**
 * Heads of the root doc and every file leaf. Offline. `pathspec` matches a
 * path exactly or as a folder prefix; "/" shows only the root doc.
 */
export async function heads(cwd: string, pathspec?: string): Promise<HeadsEntry[]> {
	const { config, docs, tree, close } = await loadSavedTree(cwd);
	try {
		const entries: HeadsEntry[] = [];
		const add = async (p: string, url: AutomergeUrl) => {
			if (matchesPathspec(p, pathspec)) {
				entries.push({ path: p, url, heads: encodeHeads(await docs.heads(url)) });
			}
		};
		await add("/", config.rootUrl);
		for (const [p, url] of flattenLeaves(tree)) await add(p, url);
		return entries.sort((a, b) => a.path.localeCompare(b.path));
	} finally {
		await close();
	}
}

function matchesPathspec(p: string, spec?: string): boolean {
	if (!spec) return true;
	if (spec === "/") return p === "/";
	const trimmed = spec.replace(/\/$/, "");
	return p === trimmed || p.startsWith(trimmed + "/");
}

// Working-tree changes against the saved tree. Offline.
async function workdirChanges(cwd: string) {
	const saved = await loadSavedTree(cwd);
	try {
		return { ...saved, changes: changes(saved.files, await walk(saved.root)) };
	} catch (e) {
		await saved.close();
		throw e;
	}
}

export async function status(cwd: string): Promise<{ diff: Diff }> {
	const { changes, close } = await workdirChanges(cwd);
	await close();
	const of = (kind: Change["kind"]) => changes.filter((c) => c.kind === kind).map((c) => c.path);
	return { diff: { added: of("added"), modified: of("modified"), deleted: of("deleted") } };
}

export async function diff(cwd: string, limitToPath?: string): Promise<Change[]> {
	const { changes, close } = await workdirChanges(cwd);
	await close();
	return limitToPath ? changes.filter((c) => c.path === limitToPath) : changes;
}

/**
 * Save the working tree's changes into a local snarf (`.pushwork/snarf/`,
 * never synced), then reset the working tree to the saved state.
 */
export async function cutWorkdir(
	cwd: string,
	opts: { name?: string } = {},
): Promise<{ id: number; entries: number }> {
	const { root, docs, tree, changes, close } = await workdirChanges(cwd);
	try {
		if (changes.length === 0) throw new Error("nothing to cut: working tree clean");
		const snarf = await appendSnarf(root, {
			name: opts.name,
			entries: changes.map((c) => ({
				path: c.path,
				kind: c.kind,
				...(c.after ? { contentBase64: encodeBytes(c.after) } : {}),
			})),
		});
		await materializeTree(docs, root, tree);
		return { id: snarf.id, entries: changes.length };
	} finally {
		await close();
	}
}

/**
 * Apply a snarf on top of the working tree and remove it. Refuses when the
 * working tree has unsaved changes.
 */
export async function pasteSnarf(
	cwd: string,
	selector?: string,
): Promise<{ id: number; entries: number; name?: string }> {
	const { root, changes, close } = await workdirChanges(cwd);
	await close();
	if (changes.length > 0) {
		throw new Error(
			"refusing to paste: working tree has uncommitted changes. run `pushwork save` or `pushwork cut` first.",
		);
	}
	const snarf = await takeSnarf(root, selector);
	if (!snarf) {
		throw new Error(selector ? `no snarf matches "${selector}"` : "nothing to paste: no snarfs");
	}
	for (const entry of snarf.entries) {
		const rel = fromPosix(entry.path);
		if (entry.kind === "deleted") {
			await fs.rm(path.join(root, rel), { force: true });
			await pruneEmptyDirs(root, path.dirname(rel));
		} else if (entry.contentBase64 != null) {
			await writeFileMkdir(path.join(root, rel), decodeBytes(entry.contentBase64));
		}
	}
	return { id: snarf.id, name: snarf.name, entries: snarf.entries.length };
}

export async function showSnarfs(cwd: string): Promise<Snarf[]> {
	return listSnarfs(path.resolve(cwd));
}

const normalizeDirs = (dirs: readonly string[]) => [
	...new Set(dirs.map(normalizeArtifactDir).filter(Boolean)),
];

const walk = async (root: string) => walkDir(root, await loadIgnore(root));

function changes(saved: Files, current: FileTree): Change[] {
	const out: Change[] = [];
	for (const [p, after] of current) {
		const before = saved.get(p)?.bytes;
		if (!before) out.push({ path: p, kind: "added", after });
		else if (!byteEq(before, after)) out.push({ path: p, kind: "modified", before, after });
	}
	for (const [p, { bytes }] of saved) {
		if (!current.has(p)) out.push({ path: p, kind: "deleted", before: bytes });
	}
	return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// Edited files change their doc in place, so file URLs stay stable.
async function pushFiles(
	docs: Docs,
	fsFiles: FileTree,
	saved: Files | undefined,
	isArtifact: IsArtifact,
): Promise<VfsNode> {
	const tree = newDir();
	for (const [posixPath, bytes] of fsFiles) {
		const artifact = isArtifact(posixPath);
		const fresh = makeFileEntry(posixPath, bytes, artifact);
		const prev = saved?.get(posixPath);
		let url: AutomergeUrl;
		if (!prev) {
			url = await docs.create(fresh);
		} else {
			url = stripHeads(prev.url);
			if (!byteEq(prev.bytes, bytes)) {
				await docs.change<UnixFileEntry>(url, (d) => applyFileEntry(d, fresh));
			}
		}
		setFileAt(tree, posixPath.split("/"), artifact ? await docs.pin(url) : url);
	}
	return tree;
}

// Re-pin artifact leaves to their docs' current (post-merge) heads. Returns the docs that moved.
async function refreshPins(
	docs: Docs,
	rootUrl: AutomergeUrl,
	shape: Shape,
	isArtifact: IsArtifact,
): Promise<AutomergeUrl[]> {
	const tree = newDir();
	let moved = false;
	for (const [p, url] of flattenLeaves(await shape.decode({ docs, root: rootUrl }))) {
		const pinned = isArtifact(p) ? await docs.pin(url) : url;
		moved ||= pinned !== url;
		setFileAt(tree, p.split("/"), pinned);
	}
	if (!moved) return [];
	const headsOf = async () =>
		new Map(await Promise.all(docs.urls().map(async (u) => [u, (await docs.heads(u)).join()] as const)));
	const before = await headsOf();
	await shape.encode({ docs, tree, previousRoot: rootUrl, isArtifactDir: isArtifact });
	const after = await headsOf();
	return [...after].filter(([u, h]) => before.get(u) !== h).map(([u]) => u);
}

async function readFileBytes(docs: Docs, tree: VfsNode): Promise<Files> {
	const out: Files = new Map();
	for (const [posixPath, url] of flattenLeaves(tree)) {
		const doc = await docs.find<UnixFileEntry>(url);
		out.set(posixPath, { url, bytes: contentToBytes(doc.content) });
	}
	return out;
}

// Make the working tree match `tree`: write what differs, delete what's not in it.
async function materializeTree(docs: Docs, root: string, tree: VfsNode): Promise<void> {
	const desired = new Map<string, Uint8Array>();
	const limit = limiter(16);
	await Promise.all(
		[...flattenLeaves(tree)].map(([posixPath, url]) =>
			limit(async () => {
				const doc = await docs.find<UnixFileEntry>(url);
				desired.set(posixPath, contentToBytes(doc.content));
			}),
		),
	);
	const present = await walk(root);
	for (const [posixPath, bytes] of desired) {
		if (byteEq(present.get(posixPath), bytes)) continue;
		await writeFileMkdir(path.join(root, fromPosix(posixPath)), bytes);
	}
	for (const posixPath of present.keys()) {
		if (desired.has(posixPath)) continue;
		await fs.rm(path.join(root, fromPosix(posixPath)), { force: true });
		await pruneEmptyDirs(root, path.dirname(fromPosix(posixPath)));
	}
}

const fromPosix = (p: string) => p.split("/").join(path.sep);

async function pruneEmptyDirs(root: string, relDir: string): Promise<void> {
	for (let dir = relDir; dir && dir !== "." && dir !== path.sep; dir = path.dirname(dir)) {
		const full = path.join(root, dir);
		const entries = await fs.readdir(full).catch(() => null);
		if (!entries || entries.length > 0) return;
		await fs.rmdir(full);
	}
}

function sameTree(a: VfsNode, b: VfsNode): boolean {
	const av = flattenLeaves(a);
	const bv = flattenLeaves(b);
	if (av.size !== bv.size) return false;
	for (const [k, v] of av) if (bv.get(k) !== v) return false;
	return true;
}

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
