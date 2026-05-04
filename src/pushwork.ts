import * as fs from "fs/promises";
import * as path from "path";
import * as Automerge from "@automerge/automerge";
import {
	isValidAutomergeUrl,
	parseAutomergeUrl,
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
import {
	DEFAULT_BRANCH,
	deleteBranchFile,
	detectDocType,
	isBranchesDoc,
	listBranchNames,
	readBranchFile,
	resolveEffectiveRoot,
	writeBranchFile,
	type BranchesDoc,
} from "./branches.js";
import { loadIgnore } from "./ignore.js";
import { byteEq, walkDir, writeFileAtomic } from "./fs-tree.js";
import { log } from "./log.js";
import { openRepo, waitForSync } from "./repo.js";
import {
	appendStash,
	decodeBytes,
	encodeBytes,
	listStashes,
	takeStash,
	type Stash,
	type StashEntry,
} from "./stash.js";
import {
	contentEquals,
	contentToBytes,
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
	branches?: boolean; // default: true
	online?: boolean; // default: true
};

export type CloneOpts = {
	url: string;
	dir: string;
	backend: Backend;
	shape: string;
	artifactDirectories?: readonly string[];
	branch?: string; // pick a specific branch on a BranchesDoc (default "default")
	online?: boolean; // default: true
};

export type Diff = {
	added: string[];
	modified: string[];
	deleted: string[];
};

export async function init(opts: InitOpts): Promise<AutomergeUrl> {
	const root = path.resolve(opts.dir);
	const useBranches = opts.branches ?? true;
	const online = opts.online ?? true;
	dlog("init root=%s backend=%s shape=%s branches=%s online=%s", root, opts.backend, opts.shape, useBranches, online);
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

		const tree = await pushFiles(repo, fsFiles, undefined, artifactDirs);
		const folderUrl = await shape.encode({ repo, tree });
		dlog("init encoded folder=%s", folderUrl);
		const folderHandle = await repo.find<unknown>(folderUrl);

		if (online) {
			await waitForSync(folderHandle, { minMs: 3000, idleMs: 1500, maxMs: 15000 });
			stampLastSyncAt(folderHandle);
			await waitForSync(folderHandle, { idleMs: 1500, maxMs: 10000 });
		}

		let rootUrl: AutomergeUrl = folderUrl;
		if (useBranches) {
			const branchesHandle = repo.create<BranchesDoc>({
				"@patchwork": { type: "branches" },
				branches: { [DEFAULT_BRANCH]: folderUrl },
			});
			if (online) {
				await waitForSync(branchesHandle, { minMs: 1500, idleMs: 1500, maxMs: 10000 });
			}
			rootUrl = branchesHandle.url;
			dlog("init wrapped in BranchesDoc=%s", rootUrl);
			await writeBranchFile(root, DEFAULT_BRANCH);
		}

		await writeConfig(root, {
			version: CONFIG_VERSION,
			rootUrl,
			backend: opts.backend,
			shape: opts.shape,
			artifactDirectories: artifactDirs,
			branches: useBranches,
		});
		dlog("init complete: rootUrl=%s", rootUrl);
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
	await fs.mkdir(pushworkDir(root), { recursive: true });

	const online = opts.online ?? true;
	const repo = await openRepo(opts.backend, storageDir(root), { offline: !online });
	try {
		const shape = await resolveShape(opts.shape);
		const rootHandle = await repo.find<unknown>(opts.url as AutomergeUrl);
		if (online) {
			await waitForSync(rootHandle, { idleMs: 1500, maxMs: 15000 });
		}
		const docType = detectDocType(rootHandle.doc());
		dlog("clone detected docType=%s", docType);

		let useBranches = false;
		let folderHandle: DocHandle<unknown> = rootHandle;
		if (docType === "branches") {
			useBranches = true;
			const branchName = opts.branch ?? DEFAULT_BRANCH;
			folderHandle = await resolveEffectiveRoot(repo, rootHandle, branchName);
			if (online) {
				await waitForSync(folderHandle, { idleMs: 1500, maxMs: 15000 });
			}
			await writeBranchFile(root, branchName);
			dlog("clone branch=%s folder=%s", branchName, folderHandle.url);
		} else if (opts.branch) {
			throw new Error(
				`--branch passed but root doc is not a branches doc (type=${docType})`,
			);
		}

		const tree = await shape.decode({ repo, root: folderHandle });
		await materializeTree(repo, root, tree);

		await writeConfig(root, {
			version: CONFIG_VERSION,
			rootUrl: opts.url as AutomergeUrl,
			backend: opts.backend,
			shape: opts.shape,
			artifactDirectories: artifactDirs,
			branches: useBranches,
		});
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
	await commitWorkdir(cwd, { online: true });
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
	const branchName = config.branches ? await readBranchFile(root) : null;
	dlog("commit online=%s root=%s branch=%s", online, root, branchName);

	const repo = await openRepo(config.backend, storageDir(root), {
		offline: !online,
	});
	try {
		const shape = await resolveShape(config.shape);
		const rootHandle = await repo.find<unknown>(config.rootUrl);

		// In branches mode + online, touch every branch's folder doc so the
		// network adapter announces them. Without this, a branch created
		// offline (`pushwork branch X`) is never pushed to the server, even
		// though its entry is in the BranchesDoc.
		const otherBranchHandles: DocHandle<unknown>[] = [];
		if (online && config.branches && isBranchesDoc(rootHandle.doc())) {
			const doc = rootHandle.doc() as BranchesDoc;
			for (const [name, url] of Object.entries(doc.branches)) {
				if (name === branchName) continue;
				otherBranchHandles.push(await repo.find<unknown>(url));
			}
		}

		const folderHandle = await resolveEffectiveRoot(repo, rootHandle, branchName);

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
			// Always stamp lastSyncAt on a sync, regardless of whether the
			// working tree changed — a sync is also a checkpoint that "we
			// reconciled with the server at this time."
			stampLastSyncAt(folderHandle);

			// Wait for the current branch's folder, the BranchesDoc itself
			// (when in branches mode), and any other branch folder docs to
			// flush. The maxMs is generous so a brand-new offline-created
			// branch reliably propagates.
			await waitForSync(folderHandle, {
				minMs: 3000,
				idleMs: 1500,
				maxMs: 15000,
			});
			if (config.branches) {
				await waitForSync(rootHandle, { idleMs: 1500, maxMs: 10000 });
			}
			for (const h of otherBranchHandles) {
				await waitForSync(h, { idleMs: 1500, maxMs: 10000 });
			}
		}

		const finalTree = await shape.decode({ repo, root: folderHandle });
		await materializeTree(repo, root, finalTree);
		dlog("commit complete");
	} finally {
		await repo.shutdown();
	}
}

export async function status(
	cwd: string,
): Promise<{ branch: string | null; diff: Diff }> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	const branchName = config.branches ? await readBranchFile(root) : null;

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const rootHandle = await repo.find<unknown>(config.rootUrl);
		const folderHandle = await resolveEffectiveRoot(repo, rootHandle, branchName);
		const previousTree = await shape.decode({ repo, root: folderHandle });
		const previousFiles = await readFileBytes(repo, previousTree);

		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);

		const diff = computeDiff(previousFiles, fsFiles);
		return { branch: branchName, diff };
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
	const branchName = config.branches ? await readBranchFile(root) : null;

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const rootHandle = await repo.find<unknown>(config.rootUrl);
		const folderHandle = await resolveEffectiveRoot(repo, rootHandle, branchName);
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

export async function listBranches(cwd: string): Promise<{ current: string | null; names: string[] }> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	if (!config.branches) {
		throw new Error("pushwork repo has no branches");
	}
	const current = await readBranchFile(root);

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const rootHandle = await repo.find<BranchesDoc>(config.rootUrl);
		const doc = rootHandle.doc();
		if (!isBranchesDoc(doc)) {
			throw new Error(`root doc at ${config.rootUrl} is not a branches doc`);
		}
		return { current, names: listBranchNames(doc) };
	} finally {
		await repo.shutdown();
	}
}

export async function currentBranch(cwd: string): Promise<string | null> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	if (!config.branches) return null;
	return readBranchFile(root);
}

export async function createBranch(cwd: string, name: string): Promise<AutomergeUrl> {
	if (!name) throw new Error("branch name is required");
	if (name.includes("/") || name.includes("\\")) {
		throw new Error("branch name may not contain slashes");
	}
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	if (!config.branches) throw new Error("pushwork repo has no branches");
	const currentName = await readBranchFile(root);
	if (!currentName) throw new Error("no current branch is set");

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const rootHandle = await repo.find<BranchesDoc>(config.rootUrl);
		const doc = rootHandle.doc();
		if (!isBranchesDoc(doc)) {
			throw new Error(`root doc at ${config.rootUrl} is not a branches doc`);
		}
		if (doc.branches[name]) {
			throw new Error(`branch "${name}" already exists`);
		}
		const sourceUrl = doc.branches[currentName];
		if (!sourceUrl) {
			throw new Error(`current branch "${currentName}" not found in branches doc`);
		}
		const sourceHandle = await repo.find<unknown>(sourceUrl);

		// Clone the folder doc.
		const clonedFolder = repo.clone(sourceHandle);
		dlog("createBranch %s cloned folder %s → %s", name, sourceUrl, clonedFolder.url);

		// Deep-clone every file doc the source folder references, then rewrite
		// the cloned folder's leaves to point at the new file URLs. Without
		// this step both branches would alias the same UnixFileEntry docs and
		// editing one branch would silently mutate the other.
		const sourceTree = await shape.decode({ repo, root: sourceHandle });
		const fileUrlRemap = new Map<AutomergeUrl, AutomergeUrl>();
		for (const [, fileUrl] of flattenLeaves(sourceTree)) {
			const bare = stripHeads(fileUrl);
			if (fileUrlRemap.has(bare)) continue;
			const orig = await repo.find<unknown>(bare);
			const cloned = repo.clone(orig);
			fileUrlRemap.set(bare, cloned.url);
			dlog("createBranch cloned file %s → %s", bare, cloned.url);
		}
		const newTree = newDir();
		for (const [posixPath, fileUrl] of flattenLeaves(sourceTree)) {
			const bare = stripHeads(fileUrl);
			const remappedBare = fileUrlRemap.get(bare);
			if (!remappedBare) continue;
			const parsed = parseAutomergeUrl(fileUrl);
			// Preserve heads-pinning if the source URL was pinned.
			let finalUrl: AutomergeUrl = remappedBare;
			if (parsed.heads) {
				const newHandle = await repo.find<unknown>(remappedBare);
				finalUrl = pinUrl(newHandle);
			}
			const segments = posixPath.split("/").filter(Boolean);
			setFileAt(newTree, segments, finalUrl);
		}
		await shape.encode({ repo, tree: newTree, previousRoot: clonedFolder });

		rootHandle.change((d: BranchesDoc) => {
			d.branches[name] = clonedFolder.url;
		});
		return clonedFolder.url;
	} finally {
		await repo.shutdown();
	}
}

export type MergeReport = {
	source: string;
	target: string;
	merged: string[]; // paths present in both branches whose file docs were merged
	added: string[]; // paths that were only in source, added to target
};

export type MergePreviewEntry = {
	path: string;
	kind: "merged" | "added";
	before?: Uint8Array;
	after: Uint8Array;
};

export type MergePreview = {
	source: string;
	target: string;
	entries: MergePreviewEntry[];
};

/**
 * Apply changes from `source` branch onto the current branch.
 *
 * For each path:
 * - In both branches: their UnixFileEntry docs share Automerge history (deep
 *   cloned at branch creation), so we Automerge-merge source's content into
 *   target's. Concurrent edits are CRDT-merged inside each file doc.
 * - Only in source: deep-clone the source's file doc into a new doc and add
 *   it to target's folder. Editing on either branch afterward stays isolated.
 * - Only in target: untouched. We don't propagate deletions from source — the
 *   user can do that explicitly.
 *
 * Refuses if the working tree has uncommitted changes against the current
 * branch (run `pushwork save` first). Offline only — propagation happens on
 * the next `pushwork sync`.
 */
/**
 * Compute what `merge <source>` would do without mutating any docs or the
 * working tree. For paths in both branches we apply the merge to a *clone*
 * of the target's file doc to learn the merged bytes; for paths only in
 * source we just read source's bytes.
 */
export async function previewMerge(
	cwd: string,
	source: string,
): Promise<MergePreview> {
	if (!source) throw new Error("source branch name is required");
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	if (!config.branches) throw new Error("pushwork repo has no branches");
	const targetName = await readBranchFile(root);
	if (!targetName) throw new Error("no current branch is set");
	if (source === targetName) {
		throw new Error(`cannot merge "${source}" into itself`);
	}

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const rootHandle = await repo.find<BranchesDoc>(config.rootUrl);
		const branchesDoc = rootHandle.doc();
		if (!isBranchesDoc(branchesDoc)) {
			throw new Error(`root doc at ${config.rootUrl} is not a branches doc`);
		}
		if (!branchesDoc.branches[source]) {
			throw new Error(`source branch "${source}" does not exist`);
		}
		const targetFolder = await repo.find<unknown>(branchesDoc.branches[targetName]);
		const sourceFolder = await repo.find<unknown>(branchesDoc.branches[source]);

		const tTree = await shape.decode({ repo, root: targetFolder });
		const sTree = await shape.decode({ repo, root: sourceFolder });
		const tLeaves = flattenLeaves(tTree);
		const sLeaves = flattenLeaves(sTree);

		const entries: MergePreviewEntry[] = [];

		for (const [posixPath, sUrl] of sLeaves) {
			const tUrl = tLeaves.get(posixPath);
			const sBare = stripHeads(sUrl);
			const sHandle = await repo.find<UnixFileEntry>(sBare);
			if (!tUrl) {
				entries.push({
					path: posixPath,
					kind: "added",
					after: contentToBytes(sHandle.doc().content),
				});
				continue;
			}
			const tBare = stripHeads(tUrl);
			if (tBare === sBare) continue;
			const tHandle = await repo.find<UnixFileEntry>(tBare);
			const before = contentToBytes(tHandle.doc().content);
			// Compute merge result without touching the target doc.
			const merged = Automerge.merge(
				Automerge.clone(tHandle.doc()),
				Automerge.clone(sHandle.doc()),
			) as UnixFileEntry;
			const after = contentToBytes(merged.content);
			if (byteEq(before, after)) continue;
			entries.push({ path: posixPath, kind: "merged", before, after });
		}

		entries.sort((a, b) => a.path.localeCompare(b.path));
		return { source, target: targetName, entries };
	} finally {
		await repo.shutdown();
	}
}

export async function mergeBranch(
	cwd: string,
	source: string,
): Promise<MergeReport> {
	if (!source) throw new Error("source branch name is required");
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	if (!config.branches) throw new Error("pushwork repo has no branches");
	const targetName = await readBranchFile(root);
	if (!targetName) throw new Error("no current branch is set");
	if (source === targetName) {
		throw new Error(`cannot merge "${source}" into itself`);
	}
	dlog("merge source=%s target=%s", source, targetName);

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const rootHandle = await repo.find<BranchesDoc>(config.rootUrl);
		const branchesDoc = rootHandle.doc();
		if (!isBranchesDoc(branchesDoc)) {
			throw new Error(`root doc at ${config.rootUrl} is not a branches doc`);
		}
		if (!branchesDoc.branches[source]) {
			throw new Error(`source branch "${source}" does not exist`);
		}
		const targetUrl = branchesDoc.branches[targetName];
		const sourceUrl = branchesDoc.branches[source];

		const targetFolder = await repo.find<unknown>(targetUrl);
		const sourceFolder = await repo.find<unknown>(sourceUrl);

		// Refuse on dirty working tree (mirror switchBranch policy).
		const tFiles = await readFileBytes(
			repo,
			await shape.decode({ repo, root: targetFolder }),
		);
		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);
		const dirty = computeDiff(tFiles, fsFiles);
		if (dirty.added.length || dirty.modified.length || dirty.deleted.length) {
			throw new Error(
				`refusing to merge: working tree has uncommitted changes on branch "${targetName}". run \`pushwork save\` first.`,
			);
		}

		const tTree = await shape.decode({ repo, root: targetFolder });
		const sTree = await shape.decode({ repo, root: sourceFolder });
		const tLeaves = flattenLeaves(tTree);
		const sLeaves = flattenLeaves(sTree);

		const merged: string[] = [];
		const added: string[] = [];

		// For paths in both: merge file docs in place.
		for (const [posixPath, sUrl] of sLeaves) {
			const tUrl = tLeaves.get(posixPath);
			if (!tUrl) continue;
			const tBare = stripHeads(tUrl);
			const sBare = stripHeads(sUrl);
			if (tBare === sBare) {
				// Same file doc identity (shared) — already in sync, nothing to do.
				continue;
			}
			const tHandle = await repo.find<UnixFileEntry>(tBare);
			const sHandle = await repo.find<UnixFileEntry>(sBare);
			tHandle.update((d) => Automerge.merge(d, Automerge.clone(sHandle.doc())));
			merged.push(posixPath);
			dlog("merge merged file at %s (%s ← %s)", posixPath, tBare, sBare);
		}

		// For paths only in source: deep-clone source's file doc, add to target's folder.
		const newLeaves = new Map<string, AutomergeUrl>();
		for (const [posixPath, sUrl] of sLeaves) {
			if (tLeaves.has(posixPath)) continue;
			const sBare = stripHeads(sUrl);
			const sHandle = await repo.find<unknown>(sBare);
			const cloned = repo.clone(sHandle);
			let finalUrl: AutomergeUrl = cloned.url;
			const parsed = parseAutomergeUrl(sUrl);
			if (parsed.heads) {
				finalUrl = pinUrl(cloned);
			}
			newLeaves.set(posixPath, finalUrl);
			added.push(posixPath);
			dlog("merge added %s url=%s", posixPath, finalUrl);
		}

		if (newLeaves.size > 0) {
			// Build a tree for the encode call: existing target leaves + new ones.
			const nextTree = newDir();
			for (const [p, url] of tLeaves) {
				setFileAt(nextTree, p.split("/").filter(Boolean), url);
			}
			for (const [p, url] of newLeaves) {
				setFileAt(nextTree, p.split("/").filter(Boolean), url);
			}
			await shape.encode({ repo, tree: nextTree, previousRoot: targetFolder });
		}

		// Materialize current branch (target) onto disk to reflect the merge.
		const finalTree = await shape.decode({ repo, root: targetFolder });
		await materializeTree(repo, root, finalTree);

		merged.sort();
		added.sort();
		return { source, target: targetName, merged, added };
	} finally {
		await repo.shutdown();
	}
}

/**
 * Capture the working tree's changes against the current branch's saved
 * state into a local stash, then reset the working tree to the saved state.
 * Stashes live in `.pushwork/stash.json` and are never synced.
 */
export async function cutWorkdir(
	cwd: string,
	opts: { name?: string } = {},
): Promise<{ id: number; entries: number }> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	const branchName = config.branches ? await readBranchFile(root) : null;
	dlog("cut root=%s branch=%s name=%s", root, branchName, opts.name ?? "(unnamed)");

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const rootHandle = await repo.find<unknown>(config.rootUrl);
		const folderHandle = await resolveEffectiveRoot(repo, rootHandle, branchName);
		const previousTree = await shape.decode({ repo, root: folderHandle });
		const previousFiles = await readFileBytes(repo, previousTree);

		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);

		const entries: StashEntry[] = [];
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

		const stash = await appendStash(root, {
			name: opts.name,
			branch: branchName,
			entries,
		});

		// Reset working tree to the branch's saved state.
		await materializeTree(repo, root, previousTree);
		dlog("cut complete id=%d entries=%d", stash.id, entries.length);
		return { id: stash.id, entries: entries.length };
	} finally {
		await repo.shutdown();
	}
}

/**
 * Apply a stash on top of the current working tree, then remove the stash
 * entry. Refuses if the working tree has uncommitted changes (caller can
 * `pushwork save` or `pushwork cut` first).
 */
export async function pasteStash(
	cwd: string,
	selector?: string,
): Promise<{ id: number; entries: number; name?: string }> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	const branchName = config.branches ? await readBranchFile(root) : null;

	// Check the working tree is clean against the current branch state.
	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const rootHandle = await repo.find<unknown>(config.rootUrl);
		const folderHandle = await resolveEffectiveRoot(repo, rootHandle, branchName);
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

	const stash = await takeStash(root, selector);
	if (!stash) {
		throw new Error(
			selector
				? `no stash matches "${selector}"`
				: "nothing to paste: no stashes",
		);
	}

	for (const entry of stash.entries) {
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

	dlog("paste complete id=%d entries=%d", stash.id, stash.entries.length);
	return { id: stash.id, name: stash.name, entries: stash.entries.length };
}

export async function showStashes(cwd: string): Promise<Stash[]> {
	return listStashes(path.resolve(cwd));
}

export async function switchBranch(cwd: string, name: string): Promise<void> {
	if (!name) throw new Error("branch name is required");
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	if (!config.branches) throw new Error("pushwork repo has no branches");
	const currentName = await readBranchFile(root);

	const repo = await openRepo(config.backend, storageDir(root), { offline: true });
	try {
		const shape = await resolveShape(config.shape);
		const rootHandle = await repo.find<BranchesDoc>(config.rootUrl);
		const doc = rootHandle.doc();
		if (!isBranchesDoc(doc)) {
			throw new Error(`root doc at ${config.rootUrl} is not a branches doc`);
		}
		if (!doc.branches[name]) {
			throw new Error(`branch "${name}" does not exist`);
		}

		// Refuse if the working dir has uncommitted changes against the current branch.
		if (currentName) {
			const folderHandle = await resolveEffectiveRoot(repo, rootHandle, currentName);
			const previousTree = await shape.decode({ repo, root: folderHandle });
			const previousFiles = await readFileBytes(repo, previousTree);
			const ig = await loadIgnore(root);
			const fsFiles = await walkDir(root, ig);
			const d = computeDiff(previousFiles, fsFiles);
			if (d.added.length || d.modified.length || d.deleted.length) {
				throw new Error(
					`refusing to switch: working tree has uncommitted changes on branch "${currentName}". run \`pushwork save\` first.`,
				);
			}
		}

		// Materialize from the new branch.
		const newFolder = await repo.find<unknown>(doc.branches[name]);
		const tree = await shape.decode({ repo, root: newFolder });
		await materializeTree(repo, root, tree);
		await writeBranchFile(root, name);
		dlog("switch → %s", name);
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
			// the file URL stable within a branch and avoids the propagation
			// race where a brand-new file doc URL is referenced by the folder
			// before its bytes have reached the sync server.
			//
			// For string content (text files) we use Automerge.updateText so
			// concurrent character-level edits merge correctly. Bytes and
			// ImmutableString are atomic — last writer wins on the field.
			//
			// Branch isolation is enforced separately: `createBranch` deep
			// clones every file doc the source branch references, so two
			// branches never share a UnixFileEntry doc identity.
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
export { deleteBranchFile };
