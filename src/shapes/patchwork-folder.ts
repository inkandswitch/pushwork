import * as path from "path";
import type { Docs } from "../docs.js";
import { log } from "../log.js";
import { isValidAutomergeUrl, stripHeads, type AutomergeUrl } from "../url.js";
import { readFileDocs, writeFileDocs } from "./file-docs.js";
import { type Shape, type VfsNode } from "./types.js";

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
};

type IsArtifactDir = (posixPath: string) => boolean;

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

const childPath = (dirPath: string, name: string) =>
	dirPath ? `${dirPath}/${name}` : name;

export const patchworkFolderShape: Shape = {
	async encode({ docs, files, previousRoot, isArtifact = () => false, fresh }) {
		const previous = previousRoot && !fresh ? await patchworkFolderShape.decode({ docs, root: previousRoot }) : undefined;
		const tree = await writeFileDocs(docs, files, previous, isArtifact);
		if (previousRoot) {
			dlog("encode reusing root=%s", previousRoot);
			await syncFolder(docs, previousRoot, tree, "", isArtifact);
			return previousRoot;
		}
		const url = await createFolder(docs, tree, "pushwork", "", isArtifact);
		dlog("encode new root=%s", url);
		return url;
	},

	async decode({ docs, root }) {
		const doc = await docs.find(root);
		if (!isFolderDoc(doc)) throw new Error(`expected folder doc at ${root}`);
		dlog("decode root=%s", root);
		return readFileDocs(docs, await readFolder(docs, doc));
	},
};

// links to artifact dirs are pinned to the folder's current heads
const folderLink = async (
	docs: Docs,
	name: string,
	url: AutomergeUrl,
	frozen: boolean,
): Promise<DocLink> => ({
	name,
	type: "folder",
	url: frozen ? await docs.pin(url) : url,
});

async function createFolder(
	docs: Docs,
	tree: VfsNode,
	title: string,
	dirPath: string,
	isArtifact: IsArtifactDir,
): Promise<AutomergeUrl> {
	if (tree.kind !== "dir") throw new Error("createFolder: not a dir");
	const links: DocLink[] = [];
	for (const [name, child] of tree.entries) {
		if (child.kind === "file") {
			links.push({ name, type: linkFileType(name), url: child.url });
			continue;
		}
		const sub = childPath(dirPath, name);
		const url = await createFolder(docs, child, name, sub, isArtifact);
		links.push(await folderLink(docs, name, url, isArtifact(sub)));
	}
	const url = await docs.create<FolderDoc>({
		"@patchwork": { type: "folder" },
		title,
		docs: links,
	});
	dlog("createFolder title=%s docs=%d url=%s", title, links.length, url);
	return url;
}

async function syncFolder(
	docs: Docs,
	url: AutomergeUrl,
	tree: VfsNode,
	dirPath: string,
	isArtifact: IsArtifactDir,
): Promise<void> {
	if (tree.kind !== "dir") throw new Error("syncFolder: not a dir");
	const doc = await docs.find<FolderDoc>(url);
	const existing = new Map(doc.docs.map(link => [link.name, link]));

	const links: DocLink[] = [];
	for (const [name, child] of tree.entries) {
		if (child.kind === "file") {
			links.push({ name, type: linkFileType(name), url: child.url });
			continue;
		}
		const sub = childPath(dirPath, name);
		const link = existing.get(name);
		// reuse the subfolder doc so its url stays stable; a pinned link can't be changed, so unpin it
		const old = link?.type === "folder" ? stripHeads(link.url) : undefined;
		if (old && isFolderDoc(await docs.find(old))) {
			await syncFolder(docs, old, child, sub, isArtifact);
			links.push(await folderLink(docs, name, old, isArtifact(sub)));
		} else {
			const url = await createFolder(docs, child, name, sub, isArtifact);
			links.push(await folderLink(docs, name, url, isArtifact(sub)));
		}
	}

	await docs.change<FolderDoc>(url, d => {
		if (!d["@patchwork"]) d["@patchwork"] = { type: "folder" };
		if (typeof d.title !== "string") d.title = "pushwork";
		if (JSON.stringify(d.docs) !== JSON.stringify(links)) d.docs = links;
	});
}

async function readFolder(docs: Docs, doc: FolderDoc): Promise<VfsNode> {
	const entries = new Map<string, VfsNode>();
	for (const link of doc.docs ?? []) {
		if (!link?.name || !isValidAutomergeUrl(link.url)) continue;
		if (link.type !== "folder") {
			entries.set(link.name, { kind: "file", url: link.url });
			continue;
		}
		const sub = await docs.find(link.url);
		if (isFolderDoc(sub)) entries.set(link.name, await readFolder(docs, sub));
	}
	return { kind: "dir", entries };
}
