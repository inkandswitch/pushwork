import * as path from "path";
import {
	type AutomergeUrl,
	type DocHandle,
	type Repo,
} from "@automerge/automerge-repo";
import { log } from "../log.js";
import { asString, asUrl, pinUrl, stripHeads } from "./file.js";
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
		asString((meta as Record<string, unknown>).type) === "folder"
	);
};

const linkFileType = (filename: string): string => {
	const ext = path.posix.extname(filename).replace(/^\./, "");
	return ext || "file";
};

/**
 * Decides whether a repo-relative posix directory path is an artifact
 * directory whose folder link should be pinned with heads. Threaded down from
 * `encode` so pinning is driven by the same config-/attributes-based classifier
 * that pins file leaves — not inferred from the children, which would
 * spuriously freeze a plain parent dir whose only child is an artifact subdir.
 */
type IsArtifactDir = (posixPath: string) => boolean;

/** The link URL for a freshly synced subfolder: pinned iff it's an artifact dir. */
const subfolderUrl = (handle: DocHandle<FolderDoc>, frozen: boolean) =>
	frozen ? pinUrl(handle) : handle.url;

const childPath = (dirPath: string, name: string) =>
	dirPath ? `${dirPath}/${name}` : name;

export const patchworkFolderShape: Shape = {
	async encode({ repo, tree, previousRoot, isArtifactDir }) {
		if (tree.kind !== "dir") throw new Error("folder: root must be a dir");
		const isArtifact: IsArtifactDir = isArtifactDir ?? (() => false);

		if (previousRoot) {
			dlog("encode reusing root=%s", previousRoot.url);
			const handle = previousRoot as DocHandle<FolderDoc>;
			// Root path is "" — never an artifact dir — so the returned flag is
			// ignored; callers track the repo by this bare URL.
			await syncFolder(repo, handle, tree, "", isArtifact);
			return handle.url;
		}
		dlog("encode creating new root");
		const { handle } = await createFolder(repo, tree, "pushwork", "", isArtifact);
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
	dirPath: string,
	isArtifact: IsArtifactDir,
): Promise<{ handle: DocHandle<FolderDoc>; frozen: boolean }> {
	if (tree.kind !== "dir") throw new Error("createFolder: not a dir");
	const links: DocLink[] = [];
	for (const [name, child] of tree.entries) {
		if (child.kind === "file") {
			links.push({ name, type: linkFileType(name), url: child.url });
		} else {
			const sub = await createFolder(
				repo,
				child,
				name,
				childPath(dirPath, name),
				isArtifact,
			);
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
	return { handle, frozen: isArtifact(dirPath) };
}

async function syncFolder(
	repo: Repo,
	handle: DocHandle<FolderDoc>,
	tree: VfsNode,
	dirPath: string,
	isArtifact: IsArtifactDir,
): Promise<boolean> {
	if (tree.kind !== "dir") throw new Error("syncFolder: not a dir");

	const desired = new Map<string, VfsNode>(tree.entries);
	const existingLinks = new Map<string, { type?: string; url: AutomergeUrl }>();
	for (const link of handle.doc().docs ?? []) {
		const name = asString(link?.name);
		const url = asUrl(link?.url);
		if (name && url) existingLinks.set(name, { type: asString(link.type), url });
	}

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
		// pin below from whether the subtree is an artifact dir.
		if (existing && existing.type === "folder") {
			const subHandle = await repo.find<FolderDoc>(stripHeads(existing.url));
			if (isFolderDoc(subHandle.doc())) {
				const frozen = await syncFolder(
					repo,
					subHandle,
					child,
					childPath(dirPath, name),
					isArtifact,
				);
				nextLinks.push({
					name,
					type: "folder",
					url: subfolderUrl(subHandle, frozen),
				});
				continue;
			}
		}
		const sub = await createFolder(
			repo,
			child,
			name,
			childPath(dirPath, name),
			isArtifact,
		);
		nextLinks.push({
			name,
			type: "folder",
			url: subfolderUrl(sub.handle, sub.frozen),
		});
	}

	handle.change((d: FolderDoc) => {
		if (!d["@patchwork"]) d["@patchwork"] = { type: "folder" };
		if (asString(d.title) === undefined) d.title = "pushwork";
		updateLinks(d, nextLinks);
	});
	return isArtifact(dirPath);
}

/**
 * Edit `d.docs` in place to match `want` rather than replacing the list, so
 * peers concurrently adding or removing different entries merge instead of
 * one whole list overwriting the other. Unchanged links (including fields
 * stored as ImmutableString) are left alone.
 */
function updateLinks(d: FolderDoc, want: DocLink[]): void {
	if (!Array.isArray(d.docs)) {
		d.docs = want;
		return;
	}
	const wanted = new Map(want.map((l) => [l.name, l]));
	const kept = new Set<string>();
	for (let i = d.docs.length - 1; i >= 0; i--) {
		const name = asString(d.docs[i]?.name);
		// Drop removed entries, and duplicates left by concurrent adds of the
		// same name (keeping the last).
		if (!name || !wanted.has(name) || kept.has(name)) {
			d.docs.splice(i, 1);
			continue;
		}
		kept.add(name);
		const link = d.docs[i];
		const next = wanted.get(name)!;
		if (asString(link.type) !== next.type) link.type = next.type;
		if (asString(link.url) !== next.url) link.url = next.url;
	}
	for (const link of want) {
		if (!kept.has(link.name)) d.docs.push(link);
	}
}

async function readFolder(
	repo: Repo,
	handle: DocHandle<FolderDoc>,
): Promise<VfsNode> {
	const doc = handle.doc();
	const tree: VfsNode = newDir();
	if (!doc?.docs) return tree;
	for (const link of doc.docs) {
		// Link fields may be plain strings or ImmutableStrings.
		const name = asString(link?.name);
		const url = asUrl(link?.url);
		if (!name || !url) continue;
		if (asString(link.type) === "folder") {
			const sub = await repo.find<FolderDoc>(url);
			if (isFolderDoc(sub.doc())) {
				const subTree = await readFolder(repo, sub);
				if (tree.kind === "dir") tree.entries.set(name, subTree);
			}
		} else {
			if (tree.kind === "dir") {
				tree.entries.set(name, { kind: "file", url });
			}
		}
	}
	return tree;
}
