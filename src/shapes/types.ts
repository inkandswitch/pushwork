import type {
	AutomergeUrl,
	DocHandle,
	ImmutableString,
	Repo,
} from "@automerge/automerge-repo";

export type VfsNode =
	| { kind: "dir"; entries: Map<string, VfsNode> }
	| { kind: "file"; url: AutomergeUrl };

export type UnixFileEntry = {
	"@patchwork": { type: "file" };
	content: string | Uint8Array | ImmutableString;
	extension: string;
	mimeType: string;
	name: string;
};

export interface Shape {
	encode(args: {
		repo: Repo;
		tree: VfsNode;
		previousRoot?: DocHandle<unknown>;
	}): Promise<AutomergeUrl>;
	decode(args: {
		repo: Repo;
		root: DocHandle<unknown>;
	}): Promise<VfsNode>;
}

export const newDir = (): VfsNode => ({ kind: "dir", entries: new Map() });

export function* walkLeaves(
	node: VfsNode,
	prefix: string[] = [],
): Generator<{ path: string[]; url: AutomergeUrl }> {
	if (node.kind === "file") {
		yield { path: prefix, url: node.url };
		return;
	}
	for (const [name, child] of node.entries) {
		yield* walkLeaves(child, [...prefix, name]);
	}
}

export function flattenLeaves(node: VfsNode): Map<string, AutomergeUrl> {
	const out = new Map<string, AutomergeUrl>();
	for (const { path, url } of walkLeaves(node)) out.set(path.join("/"), url);
	return out;
}

export function ensureDirAt(root: VfsNode, segments: string[]): VfsNode {
	if (root.kind !== "dir") throw new Error("ensureDirAt: root must be a dir");
	let current: VfsNode = root;
	for (const seg of segments) {
		if (current.kind !== "dir") throw new Error(`not a dir: ${seg}`);
		const existing = current.entries.get(seg);
		if (existing && existing.kind === "dir") {
			current = existing;
		} else {
			const fresh = newDir();
			current.entries.set(seg, fresh);
			current = fresh;
		}
	}
	return current;
}

export function setFileAt(
	root: VfsNode,
	path: string[],
	url: AutomergeUrl,
): void {
	if (path.length === 0) throw new Error("setFileAt: empty path");
	const parent = ensureDirAt(root, path.slice(0, -1));
	if (parent.kind !== "dir") throw new Error("setFileAt: parent not a dir");
	parent.entries.set(path[path.length - 1], { kind: "file", url });
}
