import * as path from "path";
import {
	isValidAutomergeUrl,
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

export const patchworkFolderShape: Shape = {
	async encode({ repo, tree, previousRoot }) {
		if (tree.kind !== "dir") throw new Error("folder: root must be a dir");

		if (previousRoot) {
			dlog("encode reusing root=%s", previousRoot.url);
			const handle = previousRoot as DocHandle<FolderDoc>;
			// Callers track the repo by the root's bare URL; only the links
			// *inside* folder docs are pinned.
			await syncFolder(repo, handle, tree);
			return handle.url;
		}
		dlog("encode creating new root");
		const handle = await createFolder(repo, tree, "pushwork");
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
): Promise<DocHandle<FolderDoc>> {
	if (tree.kind !== "dir") throw new Error("createFolder: not a dir");
	const links: DocLink[] = [];
	for (const [name, child] of tree.entries) {
		if (child.kind === "file") {
			links.push({ name, type: linkFileType(name), url: child.url });
		} else {
			const sub = await createFolder(repo, child, name);
			links.push({ name, type: "folder", url: pinUrl(sub) });
		}
	}
	const handle = repo.create<FolderDoc>({
		"@patchwork": { type: "folder" },
		title,
		docs: links,
	});
	dlog("createFolder title=%s docs=%d url=%s", title, links.length, handle.url);
	return handle;
}

async function syncFolder(
	repo: Repo,
	handle: DocHandle<FolderDoc>,
	tree: VfsNode,
): Promise<void> {
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
		// stable across syncs. Its link is pinned with heads, and a pinned URL
		// resolves to a view-only handle that throws on `.change()`, so strip
		// the heads to get the live, editable doc before syncing into it; the
		// pin is re-derived from the handle's post-sync heads.
		if (existing && existing.type === "folder") {
			const subHandle = await repo.find<FolderDoc>(stripHeads(existing.url));
			if (isFolderDoc(subHandle.doc())) {
				await syncFolder(repo, subHandle, child);
				nextLinks.push({ name, type: "folder", url: pinUrl(subHandle) });
				continue;
			}
		}
		const sub = await createFolder(repo, child, name);
		nextLinks.push({ name, type: "folder", url: pinUrl(sub) });
	}

	// Reassigning `docs` always advances the doc's heads, even when the array
	// is identical — which would move this folder's pin, its parent's link,
	// and so on up to the root on every sync. Skip the write when nothing
	// changed so pins only move when content does.
	if (!sameLinks(handle.doc(), nextLinks)) {
		handle.change((d: FolderDoc) => {
			if (!d["@patchwork"]) d["@patchwork"] = { type: "folder" };
			if (typeof d.title !== "string") d.title = "pushwork";
			d.docs = nextLinks;
		});
	}
}

function sameLinks(doc: FolderDoc, nextLinks: DocLink[]): boolean {
	if (!doc["@patchwork"] || typeof doc.title !== "string") return false;
	const current = doc.docs;
	if (!Array.isArray(current) || current.length !== nextLinks.length) {
		return false;
	}
	return nextLinks.every((link, i) => {
		const existing = current[i];
		return (
			existing.name === link.name &&
			existing.type === link.type &&
			existing.url === link.url
		);
	});
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
