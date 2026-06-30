import * as path from "path";
import {
	isValidAutomergeUrl,
	parseAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
} from "@automerge/automerge-repo";
import { log } from "../log.js";
import { pinUrl, stripHeads } from "./file.js";
import { newDir, type Shape, type VfsNode } from "./types.js";

const dlog = log("shapes:folder");

const META = "@patchwork";

type DocLink = {
	name: string;
	type: string;
	url: AutomergeUrl;
	icon?: string;
};

type FolderDoc = {
	"@patchwork": { type: "folder" };
	title: string;
	docs: DocLink[];
	lastSyncAt?: number;
};

const isFolderDoc = (doc: unknown): doc is FolderDoc => {
	if (!doc || typeof doc !== "object") return false;
	const meta = (doc as Record<string, unknown>)[META];
	return (
		!!meta &&
		typeof meta === "object" &&
		(meta as Record<string, unknown>).type === "folder"
	);
};

const linkFileType = (filename: string): string => {
	const ext = path.posix.extname(filename).replace(/^\./, "");
	return ext || "file";
};

/**
 * Whether a doc URL carries pinned heads (e.g. `automerge:…#h1|h2`). A handle
 * resolved from such a URL is view-only and throws on `.change()`.
 */
const isPinned = (url: AutomergeUrl): boolean => {
	try {
		const { heads } = parseAutomergeUrl(url);
		return !!heads && heads.length > 0;
	} catch {
		return false;
	}
};

/**
 * A folder is "frozen" — i.e. an artifact directory — when it has content and
 * every link it holds is itself pinned (artifact file leaves carry heads from
 * `pushFiles`; nested artifact folders are pinned here). Such a folder's link
 * is pinned with the folder doc's heads so Patchwork sees the whole subtree as
 * immutable, matching how it represents artifact directories. An empty folder
 * is never treated as frozen — there's nothing to mark immutable.
 */
const isFrozen = (links: DocLink[]): boolean =>
	links.length > 0 && links.every((l) => isPinned(l.url));

/** The link URL for a freshly synced subfolder: pinned iff it's frozen. */
const subfolderUrl = (handle: DocHandle<FolderDoc>, frozen: boolean) =>
	frozen ? pinUrl(handle) : handle.url;

export const patchworkFolderShape: Shape = {
	async encode({ repo, tree, previousRoot }) {
		if (tree.kind !== "dir") throw new Error("folder: root must be a dir");

		if (previousRoot) {
			dlog("encode reusing root=%s", previousRoot.url);
			const handle = previousRoot as DocHandle<FolderDoc>;
			await syncFolder(repo, handle, tree);
			return handle.url;
		}
		dlog("encode creating new root");
		// The root link is never pinned (callers track the repo by this bare
		// URL), so we ignore the frozen flag here.
		const { handle } = await createFolder(repo, tree, "pushwork");
		dlog("encode new root=%s", handle.url);
		return handle.url;
	},

	async decode({ repo, root }) {
		const doc = root.doc();
		if (!isFolderDoc(doc)) {
			throw new Error(`expected folder doc at ${root.url}`);
		}
		dlog("decode root=%s", root.url);
		return readFolder(repo, root as DocHandle<FolderDoc>);
	},
};

async function createFolder(
	repo: Repo,
	tree: VfsNode,
	title: string,
): Promise<{ handle: DocHandle<FolderDoc>; frozen: boolean }> {
	if (tree.kind !== "dir") throw new Error("createFolder: not a dir");
	const links: DocLink[] = [];
	for (const [name, child] of tree.entries) {
		if (child.kind === "file") {
			links.push({ name, type: linkFileType(name), url: child.url });
		} else {
			const sub = await createFolder(repo, child, name);
			links.push({
				name,
				type: "folder",
				url: subfolderUrl(sub.handle, sub.frozen),
			});
		}
	}
	const handle = repo.create<FolderDoc>({
		"@patchwork": { type: "folder" },
		title,
		docs: links,
	});
	dlog("createFolder title=%s docs=%d url=%s", title, links.length, handle.url);
	return { handle, frozen: isFrozen(links) };
}

async function syncFolder(
	repo: Repo,
	handle: DocHandle<FolderDoc>,
	tree: VfsNode,
): Promise<boolean> {
	if (tree.kind !== "dir") throw new Error("syncFolder: not a dir");

	const desired = new Map<string, VfsNode>(tree.entries);
	const existingLinks = new Map<string, DocLink>();
	for (const link of handle.doc().docs) existingLinks.set(link.name, link);

	const nextLinks: DocLink[] = [];

	for (const [name, child] of desired) {
		const existing = existingLinks.get(name);
		if (child.kind === "file") {
			nextLinks.push({ name, type: linkFileType(name), url: child.url });
			continue;
		}
		// child is a dir. Reuse the existing subfolder doc so its URL stays
		// stable across syncs. A subfolder link pinned with heads (our own
		// artifact dir, or one carried over from an old pushwork) resolves to a
		// view-only handle that throws on `.change()`, so strip the heads to
		// get the live, editable doc before syncing into it. We re-derive the
		// pin below from whether the subtree is still frozen.
		if (existing && existing.type === "folder") {
			const subHandle = await repo.find<FolderDoc>(stripHeads(existing.url));
			if (isFolderDoc(subHandle.doc())) {
				const frozen = await syncFolder(repo, subHandle, child);
				nextLinks.push({
					name,
					type: "folder",
					url: subfolderUrl(subHandle, frozen),
				});
				continue;
			}
		}
		const sub = await createFolder(repo, child, name);
		nextLinks.push({
			name,
			type: "folder",
			url: subfolderUrl(sub.handle, sub.frozen),
		});
	}

	handle.change((d: FolderDoc) => {
		if (!d["@patchwork"]) d["@patchwork"] = { type: "folder" };
		if (typeof d.title !== "string") d.title = "pushwork";
		d.docs = nextLinks;
	});
	return isFrozen(nextLinks);
}

async function readFolder(
	repo: Repo,
	handle: DocHandle<FolderDoc>,
): Promise<VfsNode> {
	const doc = handle.doc();
	const tree: VfsNode = newDir();
	if (!doc?.docs) return tree;
	for (const link of doc.docs) {
		if (!link?.name) continue;
		if (!isValidAutomergeUrl(link.url)) continue;
		if (link.type === "folder") {
			const sub = await repo.find<FolderDoc>(link.url);
			if (isFolderDoc(sub.doc())) {
				const subTree = await readFolder(repo, sub);
				if (tree.kind === "dir") tree.entries.set(link.name, subTree);
			}
		} else {
			if (tree.kind === "dir") {
				tree.entries.set(link.name, { kind: "file", url: link.url });
			}
		}
	}
	return tree;
}
