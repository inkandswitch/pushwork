import * as fs from "fs/promises";
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
} from "./config.js";
import { loadIgnore } from "./ignore.js";
import { byteEq, walkDir, writeFileAtomic } from "./fs-tree.js";
import { log } from "./log.js";
import { openRepo, waitForSync } from "./repo.js";
import {
	contentToBytes,
	contentEquals,
	flattenLeaves,
	isInArtifactDir,
	makeFileEntry,
	newDir,
	normalizeArtifactDir,
	pinUrl,
	resolveShape,
	setFileAt,
	stripHeads,
	type Shape,
	type UnixFileEntry,
	type VfsNode,
} from "./shapes/index.js";

const dlog = log("pushwork");

const DEFAULT_ARTIFACT_DIRECTORIES = ["dist"];

export type InitOpts = {
	dir: string;
	backend: Backend;
	shape: string;
	artifactDirectories?: readonly string[];
};

export type CloneOpts = {
	url: string;
	dir: string;
	backend: Backend;
	shape: string;
	artifactDirectories?: readonly string[];
};

export async function init(opts: InitOpts): Promise<AutomergeUrl> {
	const root = path.resolve(opts.dir);
	dlog("init root=%s backend=%s shape=%s", root, opts.backend, opts.shape);
	if (await configExists(root)) {
		throw new Error(`pushwork already initialized at ${root}`);
	}
	const artifactDirs = normalizeDirs(
		opts.artifactDirectories ?? DEFAULT_ARTIFACT_DIRECTORIES,
	);
	dlog("init artifactDirs=%o", artifactDirs);
	await fs.mkdir(pushworkDir(root), { recursive: true });

	const repo = await openRepo(opts.backend, storageDir(root));
	try {
		const shape = await resolveShape(opts.shape);
		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);
		dlog("init walked %d files", fsFiles.size);

		const tree = await pushFiles(repo, fsFiles, undefined, artifactDirs);
		const rootUrl = await shape.encode({ repo, tree });
		dlog("init encoded root=%s", rootUrl);
		const rootHandle = await repo.find<unknown>(rootUrl);

		dlog("init waiting for initial sync");
		await waitForSync(rootHandle, {
			minMs: 3000,
			idleMs: 1500,
			maxMs: 15000,
		});
		stampLastSyncAt(rootHandle);
		dlog("init stamped lastSyncAt, waiting for stamp to sync");
		await waitForSync(rootHandle, { idleMs: 1500, maxMs: 10000 });

		await writeConfig(root, {
			version: CONFIG_VERSION,
			rootUrl,
			backend: opts.backend,
			shape: opts.shape,
			artifactDirectories: artifactDirs,
		});
		dlog("init complete: %s", rootUrl);
		return rootUrl;
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
	dlog("clone artifactDirs=%o", artifactDirs);
	await fs.mkdir(pushworkDir(root), { recursive: true });
	await writeConfig(root, {
		version: CONFIG_VERSION,
		rootUrl: opts.url as AutomergeUrl,
		backend: opts.backend,
		shape: opts.shape,
		artifactDirectories: artifactDirs,
	});

	const repo = await openRepo(opts.backend, storageDir(root));
	try {
		const shape = await resolveShape(opts.shape);
		dlog("clone fetching root doc");
		const rootHandle = await repo.find<unknown>(opts.url as AutomergeUrl);
		await waitForSync(rootHandle, { idleMs: 1500, maxMs: 15000 });
		dlog("clone decoding tree");
		const tree = await shape.decode({ repo, root: rootHandle });
		await materializeTree(repo, root, tree);
		dlog("clone complete");
	} finally {
		await repo.shutdown();
	}
}

export async function url(cwd: string): Promise<AutomergeUrl> {
	const config = await readConfig(path.resolve(cwd));
	return config.rootUrl;
}

export async function sync(cwd: string): Promise<void> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	const artifactDirs = config.artifactDirectories;
	dlog("sync root=%s shape=%s artifactDirs=%o", root, config.shape, artifactDirs);

	const repo = await openRepo(config.backend, storageDir(root));
	try {
		const shape = await resolveShape(config.shape);
		const rootHandle = await repo.find<unknown>(config.rootUrl);

		const previousTree = await shape.decode({ repo, root: rootHandle });
		const previousFiles = await readFileBytes(repo, previousTree);
		dlog("sync previous files: %d", previousFiles.size);

		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);
		dlog("sync fs files: %d", fsFiles.size);

		const newTree = await pushFiles(
			repo,
			fsFiles,
			previousFiles,
			artifactDirs,
		);
		const changed = !sameTree(previousTree, newTree);
		dlog("sync tree changed: %s", changed);
		if (changed) {
			await shape.encode({ repo, tree: newTree, previousRoot: rootHandle });
		}

		dlog("sync waiting for sync");
		await waitForSync(rootHandle, {
			minMs: changed ? 3000 : 1500,
			idleMs: 1500,
			maxMs: 15000,
		});
		if (changed) {
			stampLastSyncAt(rootHandle);
			dlog("sync stamped lastSyncAt, waiting for stamp to sync");
			await waitForSync(rootHandle, { idleMs: 1500, maxMs: 10000 });
		}

		const finalTree = await shape.decode({ repo, root: rootHandle });
		await materializeTree(repo, root, finalTree);
		dlog("sync complete");
	} finally {
		await repo.shutdown();
	}
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
			baseUrl = stripHeads(prev.url);
			unchanged++;
		} else if (prev) {
			const refreshUrl = stripHeads(prev.url);
			const handle = await repo.find<UnixFileEntry>(refreshUrl);
			handle.change((d: UnixFileEntry) => {
				if (!contentEquals(d.content, fresh.content)) d.content = fresh.content;
				if (d.extension !== fresh.extension) d.extension = fresh.extension;
				if (d.mimeType !== fresh.mimeType) d.mimeType = fresh.mimeType;
				if (d.name !== fresh.name) d.name = fresh.name;
				if (!d["@patchwork"]) d["@patchwork"] = { type: "file" };
			});
			baseUrl = refreshUrl;
			updated++;
			dlog("pushFiles updated %s artifact=%s bytes=%d", posixPath, isArtifact, bytes.length);
		} else {
			const handle = repo.create<UnixFileEntry>(fresh);
			baseUrl = handle.url;
			created++;
			dlog("pushFiles created %s url=%s artifact=%s bytes=%d", posixPath, baseUrl, isArtifact, bytes.length);
		}

		const url = isArtifact
			? pinUrl(await repo.find<UnixFileEntry>(baseUrl))
			: baseUrl;
		setFileAt(root, segments, url);
	}
	dlog("pushFiles done: %d created, %d updated, %d unchanged", created, updated, unchanged);
	return root;
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
): Promise<void> {
	const desired = new Map<string, Uint8Array>();
	for (const [posixPath, fileUrl] of flattenLeaves(tree)) {
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
		dlog("materialize wrote %s (%d bytes)", posixPath, bytes.length);
	}
	for (const posixPath of present.keys()) {
		if (desired.has(posixPath)) continue;
		try {
			await fs.unlink(path.join(root, fromPosix(posixPath)));
			removed++;
			dlog("materialize removed %s", posixPath);
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

export type { Shape, UnixFileEntry, VfsNode };
