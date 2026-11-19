import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";
import {
	isImmutableString,
	isValidAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
	type UrlHeads,
} from "@automerge/automerge-repo";
import { attributesTreeOf } from "./attributes.js";
import { forkDraft } from "./drafts/actions.js";
import { treeMembers } from "./drafts/tree.js";
import { DraftView } from "./drafts/view.js";
import { GitRepo, githubRepoOf, type TreeChange } from "./git.js";
import { log } from "./log.js";
import { datatypeClassifier, pushFiles, readLeaves, type StoredLeaf } from "./pushwork.js";
import {
	openRepo,
	safeShutdown,
	waitForServerSync,
	type SyncSnapshot,
} from "./repo.js";
import type { Backend } from "./config.js";
import {
	isFileEntryDoc,
	isInArtifactDir,
	patchworkFolderShape,
	stripHeads,
} from "./shapes/index.js";

const dlog = log("import-git");

// `pushwork import-git`: a git repository as a Patchwork workspace with
// drafts, the way strand's drafts and its git sync read one.
//
// Main (the default branch) becomes the workspace: a patchwork-folder tree,
// built by replaying the branch's first-parent history one commit at a time,
// so the workspace's history has a version for each of those commits. Every
// other branch becomes a draft of main, copied from main as of the commit it
// was branched from, with the branch's changes since written through a
// DraftView, so only the docs the branch changes are cloned into the draft.
// Files go in the way `pushwork init` and `sync` write them: datatype rules
// from .pushworkattributes make JSON documents, artifacts are atomic.
//
// Each of those versions is recorded as a sync point (a commit and the
// heads of every folder and leaf doc at it, JSON documents included, read the
// way strand's git sync reads them), which is what strand's git sync starts
// from: the workspace arrives already connected, and each draft
// already linked with its branch. Git itself is untouched.

// --- strand's draft docs (drafts' draft-types.ts) ---------------------------

type CloneEntry = {
	source?: AutomergeUrl;
	clonedAt: UrlHeads;
	cloneUrl?: AutomergeUrl;
};

type SyncPoint = {
	sha: string;
	tree: string;
	heads: Record<AutomergeUrl, UrlHeads>;
	at: number;
};

type DraftDoc = {
	"@patchwork": { type: "draft" };
	isMain?: boolean;
	name?: string;
	parent: AutomergeUrl;
	drafts: AutomergeUrl[];
	clones: Record<AutomergeUrl, CloneEntry>;
	git?: { syncPoints: Record<string, SyncPoint> };
	remote?: { owner: string; repo: string; branch: string };
};

type DocLink = { name: string; type: string; url: AutomergeUrl };

type FolderDoc = {
	"@patchwork": { type: "folder"; mainDraftUrl?: AutomergeUrl };
	title: string;
	docs: DocLink[];
};

// --- Options and results -----------------------------------------------------

export type ImportOpts = {
	gitDir: string;
	backend: Backend;
	// the branch main is made from; default: the checked-out branch
	main?: string;
	// branches to make drafts of; default: every other local branch
	branches?: string[];
	// how far back main's first-parent history is replayed, at most
	// (default 200). Branches started further back are skipped.
	depth?: number;
	// replay all of that, not only from the oldest commit a draft starts at
	history?: boolean;
	// the GitHub repo strand's git sync talks to; default: from origin.
	// null: none.
	github?: { owner: string; repo: string } | null;
	artifactDirectories?: readonly string[];
	online?: boolean;
	// where the automerge storage goes; default: a temp dir, removed once
	// the server has everything
	storageDir?: string;
};

export type ImportedDraft = { branch: string; url: AutomergeUrl; changed: number };

export type ImportSummary = {
	url: AutomergeUrl;
	mainDraft: AutomergeUrl;
	main: { branch: string; commits: number; files: number };
	drafts: ImportedDraft[];
	skipped: { branch: string; reason: string }[];
	github?: { owner: string; repo: string };
	sync?: SyncSnapshot[];
	storageDir: string;
	storageKept: boolean;
};

type Reporter = (phase: string) => void;
type Warn = (message: string) => void;

type Branch = { name: string; tip: string; forkAt: string };

export async function importGit(
	opts: ImportOpts,
	report: Reporter = () => {},
	warn: Warn = () => {},
): Promise<ImportSummary> {
	const git = new GitRepo(path.resolve(opts.gitDir));
	const online = opts.online ?? true;

	const mainName = opts.main ?? (await git.currentBranch());
	if (!mainName) {
		throw new Error("HEAD is detached: name the branch to make main with --main.");
	}
	const mainTip = await git.resolve(mainName);
	const github =
		opts.github === null
			? undefined
			: (opts.github ?? githubRepoOf(await git.remoteUrl()));
	if (!github && opts.github !== null) {
		warn("origin isn't a GitHub repository, so strand's git sync won't be connected.");
	}

	report("Reading git history");
	const chain = await git.firstParents(mainTip);
	const onMain = new Map(chain.map((sha, i) => [sha, i]));
	const { branches, skipped } = await planBranches(git, opts, mainName, mainTip, onMain);

	// Replay from the oldest commit a draft starts at (just the tip, with no
	// drafts), or `depth` back with `history`; never further than `depth`.
	const depth = Math.max(1, opts.depth ?? 200);
	const floor = Math.max(0, chain.length - depth);
	const needed = Math.min(...branches.map((b) => onMain.get(b.forkAt)!), chain.length - 1);
	const start = opts.history ? floor : Math.max(floor, needed);
	const kept: Branch[] = [];
	for (const branch of branches) {
		if (onMain.get(branch.forkAt)! < start) {
			skipped.push({
				branch: branch.name,
				reason: `branched off more than ${depth} commits back; raise --depth`,
			});
		} else {
			kept.push(branch);
		}
	}
	const replay = chain.slice(start);
	for (const sha of [mainTip, ...kept.map((b) => b.tip)]) {
		await warnIfUnpushed(git, sha, kept, mainName, mainTip, warn);
	}

	const storageDir =
		opts.storageDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-import-")));
	const repo = await openRepo(opts.backend, storageDir, { offline: !online });
	const forksAt = new Map<string, Branch[]>();
	for (const branch of kept) {
		forksAt.set(branch.forkAt, [...(forksAt.get(branch.forkAt) ?? []), branch]);
	}

	let storageKept = true;
	try {
		const title = path.basename(git.dir);
		const files = new Map<string, Uint8Array>();
		let previous: Map<string, StoredLeaf> | undefined;
		let root: DocHandle<FolderDoc> | undefined;
		let mainDraft: DocHandle<DraftDoc> | undefined;
		const drafts: ImportedDraft[] = [];
		const importedAt = Date.now();
		let order = 0;

		for (const [i, sha] of replay.entries()) {
			report(`Replaying ${mainName}: commit ${i + 1} of ${replay.length}`);
			if (i === 0) {
				for (const file of await git.files(sha)) files.set(file.path, await git.blob(file.sha));
			} else {
				await applyChanges(git, files, await git.changes(replay[i - 1], sha));
			}
			const rules = classifiers(files, opts.artifactDirectories);
			const { tree, bases } = await pushFiles(
				repo,
				files,
				previous,
				rules.isArtifact,
				rules.datatypeOf,
				false,
				warn,
			);
			const url = await patchworkFolderShape.encode({
				repo,
				tree,
				previousRoot: root as DocHandle<unknown> | undefined,
				title,
			});
			if (!root) {
				root = await repo.find<FolderDoc>(url);
				mainDraft = repo.create<DraftDoc>({
					"@patchwork": { type: "draft" },
					isMain: true,
					parent: root.url,
					drafts: [],
					clones: {},
					git: { syncPoints: {} },
					...(github ? { remote: { ...github, branch: mainName } } : {}),
				});
				const mainDraftUrl = mainDraft.url;
				root.change((d: FolderDoc) => {
					d["@patchwork"].mainDraftUrl = mainDraftUrl;
				});
			}
			previous = await readLeaves(repo, tree, rules.datatypeOf, bases);

			const view = await readView(repo, root.url, {});
			const point = {
				sha,
				tree: await git.treeOf(sha),
				heads: view.heads,
				at: importedAt + order++,
			};
			recordSyncPoint(mainDraft!, point);

			for (const branch of forksAt.get(sha) ?? []) {
				report(`Making a draft of ${branch.name}`);
				const draft = await draftOf(git, repo, {
					branch,
					root,
					at: point,
					files,
					previous,
					title,
					artifactDirectories: opts.artifactDirectories,
					order: importedAt + order++,
				});
				drafts.push(draft);
			}
		}

		const handles: DocHandle<unknown>[] = [root!, mainDraft!];
		for (const draft of drafts) handles.push(await repo.find(draft.url));
		let sync: SyncSnapshot[] | undefined;
		if (online) {
			report("Publishing to the sync server");
			sync = [];
			for (const handle of handles) {
				sync.push(
					await waitForServerSync(repo, handle, opts.backend, { idleMs: 1500, maxMs: 30000 }),
				);
			}
			storageKept = !!opts.storageDir || !sync.every((s) => s.synced);
		}
		return {
			url: root!.url,
			mainDraft: mainDraft!.url,
			main: { branch: mainName, commits: replay.length, files: files.size },
			drafts,
			skipped,
			github,
			sync,
			storageDir,
			storageKept,
		};
	} finally {
		git.close();
		await safeShutdown(repo);
		if (!storageKept) {
			await fs.rm(storageDir, { recursive: true, force: true });
			await fs.rm(`${storageDir}.lmdb`, { recursive: true, force: true });
		}
	}
}

// Which branches become drafts, and where on main's first-parent history
// each was branched from: the newest commit of main's the branch has.
async function planBranches(
	git: GitRepo,
	opts: ImportOpts,
	mainName: string,
	mainTip: string,
	onMain: Map<string, number>,
): Promise<{ branches: Branch[]; skipped: { branch: string; reason: string }[] }> {
	const names = opts.branches ?? (await git.branches()).filter((name) => name !== mainName);
	const branches: Branch[] = [];
	const skipped: { branch: string; reason: string }[] = [];
	for (const name of names) {
		if (name === mainName) continue;
		const tip = await git.resolve(name);
		if (await git.isAncestor(tip, mainTip)) {
			skipped.push({ branch: name, reason: `already merged into ${mainName}` });
			continue;
		}
		const base = await git.mergeBase(mainTip, tip);
		if (!base) {
			skipped.push({ branch: name, reason: `shares no history with ${mainName}` });
			continue;
		}
		let forkAt = onMain.has(base) ? base : undefined;
		if (!forkAt) {
			// Branched off a side branch main merged later: start from the
			// newest commit of main's own line the branch has.
			const chain = [...onMain.keys()];
			for (let i = onMain.get(mainTip)!; i >= 0 && !forkAt; i--) {
				if (await git.isAncestor(chain[i], tip)) forkAt = chain[i];
			}
		}
		if (!forkAt) {
			skipped.push({ branch: name, reason: `has none of ${mainName}'s own history` });
			continue;
		}
		branches.push({ name, tip, forkAt });
	}
	return { branches, skipped };
}

async function warnIfUnpushed(
	git: GitRepo,
	sha: string,
	branches: Branch[],
	mainName: string,
	mainTip: string,
	warn: Warn,
): Promise<void> {
	const name = sha === mainTip ? mainName : branches.find((b) => b.tip === sha)?.name;
	if (!name) return;
	const upstream = await git.upstreamOf(name);
	if (upstream && upstream !== sha) {
		warn(
			`${name} isn't the same as its upstream; push it before syncing from strand, or strand will see the branch as rewritten.`,
		);
	}
}

async function applyChanges(
	git: GitRepo,
	files: Map<string, Uint8Array>,
	changes: TreeChange[],
): Promise<void> {
	for (const change of changes) {
		if (change.kind === "delete") files.delete(change.path);
		else files.set(change.path, await git.blob(change.sha));
	}
}

// The rules a tree's own .pushworkattributes files set: which paths are
// artifacts (or the given directories, without any), and which datatype a
// path's file is stored as.
function classifiers(files: Map<string, Uint8Array>, artifactDirectories: readonly string[] = ["dist"]) {
	const attrs = attributesTreeOf(files);
	return {
		isArtifact: attrs.hasArtifactRules
			? (p: string) => attrs.isArtifact(p)
			: (p: string) => isInArtifactDir(p, artifactDirectories),
		datatypeOf: datatypeClassifier(attrs),
	};
}

function recordSyncPoint(state: DocHandle<DraftDoc>, point: SyncPoint): void {
	const id = Math.random().toString(36).slice(2, 10);
	const copy: SyncPoint = JSON.parse(JSON.stringify(point));
	state.change((d: DraftDoc) => {
		d.git ??= { syncPoints: {} };
		d.git.syncPoints[`${point.sha}/${id}`] = copy;
	});
}

// --- Reading a workspace the way strand's git sync does ---------------------

type View = {
	// the heads of every folder and file doc, keyed by original url
	heads: Record<AutomergeUrl, UrlHeads>;
	// folder path ("" for the root) → folder doc
	folders: Map<string, AutomergeUrl>;
	// file path → file doc
	files: Map<string, AutomergeUrl>;
};

// The workspace as main (no clones) or a draft (its clones) sees it: a
// draft reads its clone of a doc, or the original as of the fork point.
async function readView(
	repo: Repo,
	rootUrl: AutomergeUrl,
	clones: Record<AutomergeUrl, CloneEntry>,
): Promise<View> {
	const view: View = { heads: {}, folders: new Map(), files: new Map() };
	const seen = new Set<AutomergeUrl>();
	const read = async (url: AutomergeUrl) => {
		const entry = clones[url];
		if (entry?.cloneUrl) {
			const handle = await repo.find<unknown>(entry.cloneUrl);
			return { doc: handle.doc(), heads: handle.heads() };
		}
		const handle = await repo.find<unknown>(entry?.source ?? url);
		if (!entry) return { doc: handle.doc(), heads: handle.heads() };
		return { doc: handle.view(entry.clonedAt).doc(), heads: entry.clonedAt };
	};
	const walk = async (url: AutomergeUrl, dir: string) => {
		if (seen.has(url)) return;
		seen.add(url);
		const folder = await read(url);
		const docs = (folder.doc as Partial<FolderDoc> | undefined)?.docs;
		if (!Array.isArray(docs)) return;
		view.folders.set(dir, url);
		view.heads[url] = folder.heads;
		for (const link of docs) {
			if (!link?.name || !isValidAutomergeUrl(link.url) || link.name.includes("/")) continue;
			const child = stripHeads(link.url);
			const childPath = dir ? `${dir}/${link.name}` : link.name;
			if (link.type === "folder") {
				await walk(child, childPath);
				continue;
			}
			const file = await read(child);
			if (Array.isArray((file.doc as Partial<FolderDoc> | undefined)?.docs)) {
				await walk(child, childPath);
				continue;
			}
			if (!isLeaf(file.doc) || view.files.has(childPath) || seen.has(child)) continue;
			seen.add(child);
			view.heads[child] = file.heads;
			view.files.set(childPath, child);
		}
	};
	await walk(stripHeads(rootUrl), "");
	return view;
}

// A leaf as strand's git sync reads one (its `readFiles`): a file doc whose
// content it can read, or any other doc, which is a JSON document.
function isLeaf(doc: unknown): boolean {
	if (!doc || typeof doc !== "object") return false;
	if (!isFileEntryDoc(doc)) return true;
	const content = (doc as { content?: unknown }).content;
	return typeof content === "string" || isImmutableString(content) || content instanceof Uint8Array;
}

// --- Drafts ------------------------------------------------------------------

// A draft of `branch`, forked off main as of `at` (where main's replay is now,
// so the fork records `at`'s versions), with the branch's files written
// through a DraftView: the docs the branch changes are cloned into the draft,
// the ones it adds are the draft's own, and main's docs are left alone.
// Records the branch tip as the draft's sync point.
async function draftOf(
	git: GitRepo,
	repo: Repo,
	args: {
		branch: Branch;
		root: DocHandle<FolderDoc>;
		at: SyncPoint;
		files: Map<string, Uint8Array>;
		previous: Map<string, StoredLeaf>;
		title: string;
		artifactDirectories?: readonly string[];
		order: number;
	},
): Promise<ImportedDraft> {
	const { branch, root } = args;
	const members = await treeMembers(repo, patchworkFolderShape, root as DocHandle<unknown>);
	const draftUrl = await forkDraft(repo, root, members, null, branch.name);

	const tipFiles = new Map(args.files);
	const changes = await git.changes(args.at.sha, branch.tip);
	await applyChanges(git, tipFiles, changes);
	const rules = classifiers(tipFiles, args.artifactDirectories);

	const view = await DraftView.open(repo, draftUrl);
	const { tree } = await pushFiles(
		view.repo,
		tipFiles,
		args.previous,
		rules.isArtifact,
		rules.datatypeOf,
		false,
		() => {},
	);
	await patchworkFolderShape.encode({
		repo: view.repo,
		tree,
		previousRoot: await view.repo.find<unknown>(root.url),
		title: args.title,
	});

	const draft = view.draft as unknown as DocHandle<DraftDoc>;
	const tipView = await readView(repo, root.url, draft.doc().clones);
	recordSyncPoint(draft, {
		sha: branch.tip,
		tree: await git.treeOf(branch.tip),
		heads: tipView.heads,
		at: args.order,
	});
	dlog("draft %s url=%s changes=%d", branch.name, draftUrl, changes.length);
	return { branch: branch.name, url: draftUrl, changed: changes.length };
}
