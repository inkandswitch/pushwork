// For shapes that keep each file in a doc of its own (vfs, patchwork-folder).
import { limiter, type Docs } from "../docs.js";
import { byteEq } from "../fs-tree.js";
import { stripHeads } from "../url.js";
import { applyFileEntry, contentToBytes, makeFileEntry } from "./file.js";
import { flattenLeaves, newDir, setFileAt, type File, type UnixFileEntry, type VfsNode } from "./types.js";

/** File docs for `files`, reusing those in `previous` and pinning artifacts to their current heads. */
export async function writeFileDocs(
	docs: Docs,
	files: Map<string, Uint8Array>,
	previous: Map<string, File> | undefined,
	isArtifact: (posixPath: string) => boolean,
): Promise<VfsNode> {
	const tree = newDir();
	for (const [posixPath, bytes] of files) {
		const artifact = isArtifact(posixPath);
		const fresh = makeFileEntry(posixPath, bytes, artifact);
		const prev = previous?.get(posixPath);
		let url = prev?.url && stripHeads(prev.url);
		if (!url) {
			url = await docs.create(fresh);
		} else if (!byteEq(prev!.bytes, bytes)) {
			await docs.change<UnixFileEntry>(url, d => applyFileEntry(d, fresh));
		}
		setFileAt(tree, posixPath.split("/"), artifact ? await docs.pin(url) : url);
	}
	return tree;
}

/** Every file doc in `tree`, read. */
export async function readFileDocs(docs: Docs, tree: VfsNode): Promise<Map<string, File>> {
	const limit = limiter(16);
	const leaves = [...flattenLeaves(tree)];
	const found = await Promise.all(leaves.map(([, url]) => limit(() => docs.find<UnixFileEntry>(url))));
	return new Map(leaves.map(([posixPath, url], i) => [posixPath, { url, bytes: contentToBytes(found[i].content) }]));
}
