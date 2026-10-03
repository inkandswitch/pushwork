import { log } from "../log.js";
import { isValidAutomergeUrl } from "../url.js";
import { flattenLeaves, newDir, setFileAt, type Shape } from "./types.js";

const dlog = log("shapes:vfs");

const META = "@patchwork";

type DirectoryDoc = {
	"@patchwork": { type: "directory"; title?: string };
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

// lastSyncAt is no longer written, but old docs still have it
const RESERVED = new Set([META, "lastSyncAt"]);

export const vfsShape: Shape = {
	async encode({ docs, tree, previousRoot, title }) {
		if (tree.kind !== "dir") throw new Error("vfs: root must be a dir");
		const flat = flattenLeaves(tree);
		dlog("encode keys=%d previousRoot=%s", flat.size, previousRoot ?? "<new>");

		const url =
			previousRoot ??
			(await docs.create<DirectoryDoc>({
				"@patchwork": { type: "directory", ...(title ? { title } : {}) },
			}));

		await docs.change<DirectoryDoc>(url, d => {
			if (!d["@patchwork"]) d["@patchwork"] = { type: "directory" };
			if (title && d["@patchwork"].title !== title) d["@patchwork"].title = title;
			for (const k of Object.keys(d)) {
				if (RESERVED.has(k)) continue;
				if (!flat.has(k)) delete d[k];
			}
			for (const [k, leaf] of flat) {
				if (d[k] !== leaf) d[k] = leaf;
			}
		});

		dlog("encode complete url=%s", url);
		return url;
	},

	async decode({ docs, root }) {
		const doc = await docs.find(root);
		if (!isDirectoryDoc(doc)) {
			throw new Error(`expected directory doc at ${root}`);
		}
		const tree = newDir();
		for (const [key, value] of Object.entries(doc)) {
			if (RESERVED.has(key)) continue;
			if (!isValidAutomergeUrl(value)) continue;
			const segments = key.split("/").filter(Boolean);
			if (segments.length === 0) continue;
			setFileAt(tree, segments, value);
		}
		dlog("decode url=%s", root);
		return tree;
	},
};
