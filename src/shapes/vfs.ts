import {
	isValidAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
} from "@automerge/automerge-repo";
import { log } from "../log.js";
import { flattenLeaves, newDir, type Shape, type VfsNode } from "./types.js";

const dlog = log("shapes:vfs");

const META = "@patchwork";

type DirectoryDoc = {
	"@patchwork": { type: "directory"; title?: string };
	lastSyncAt?: number;
	[key: string]: unknown;
};

const isDirectoryDoc = (doc: unknown): doc is DirectoryDoc => {
	if (!doc || typeof doc !== "object") return false;
	const meta = (doc as Record<string, unknown>)[META];
	return (
		!!meta &&
		typeof meta === "object" &&
		(meta as Record<string, unknown>).type === "directory"
	);
};

const RESERVED = new Set([META, "lastSyncAt"]);

export const vfsShape: Shape = {
	async encode({ repo, tree, previousRoot, title }) {
		if (tree.kind !== "dir") throw new Error("vfs: root must be a dir");
		const flat = flattenLeaves(tree);
		dlog("encode keys=%d previousRoot=%s", flat.size, previousRoot?.url ?? "<new>");

		const handle =
			(previousRoot as DocHandle<DirectoryDoc> | undefined) ??
			repo.create<DirectoryDoc>({
				"@patchwork": { type: "directory", ...(title ? { title } : {}) },
			});

		handle.change((d: DirectoryDoc) => {
			if (!d["@patchwork"]) d["@patchwork"] = { type: "directory" };
			if (title && d["@patchwork"].title !== title) d["@patchwork"].title = title;
			for (const k of Object.keys(d)) {
				if (RESERVED.has(k)) continue;
				if (!flat.has(k)) delete d[k];
			}
			for (const [k, url] of flat) {
				d[k] = url;
			}
		});

		dlog("encode complete url=%s", handle.url);
		return handle.url;
	},

	async decode({ root }) {
		const doc = root.doc();
		if (!isDirectoryDoc(doc)) {
			throw new Error(`expected directory doc at ${root.url}`);
		}
		const tree: VfsNode = newDir();
		let count = 0;
		for (const [key, value] of Object.entries(doc)) {
			if (RESERVED.has(key)) continue;
			if (typeof value !== "string") continue;
			if (!isValidAutomergeUrl(value)) continue;
			const segments = key.split("/").filter(Boolean);
			if (segments.length === 0) continue;
			setLeaf(tree, segments, value as AutomergeUrl);
			count++;
		}
		dlog("decode url=%s leaves=%d", root.url, count);
		return tree;
	},
};

function setLeaf(root: VfsNode, segments: string[], url: AutomergeUrl): void {
	if (root.kind !== "dir") throw new Error("setLeaf: root must be a dir");
	let cur: VfsNode = root;
	for (let i = 0; i < segments.length - 1; i++) {
		if (cur.kind !== "dir") return;
		const name = segments[i];
		const existing = cur.entries.get(name);
		if (existing && existing.kind === "dir") {
			cur = existing;
		} else {
			const fresh = newDir();
			cur.entries.set(name, fresh);
			cur = fresh;
		}
	}
	if (cur.kind !== "dir") return;
	cur.entries.set(segments[segments.length - 1], { kind: "file", url });
}
