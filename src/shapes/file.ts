import * as path from "path";
import mime from "mime-types";
import {
	ImmutableString,
	isImmutableString,
	parseAutomergeUrl,
	stringifyAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
} from "@automerge/automerge-repo";
import type { UnixFileEntry } from "./types.js";

export type Content = string | Uint8Array | ImmutableString;

export function bytesToContent(
	bytes: Uint8Array,
	isArtifact: boolean,
): Content {
	if (bytes.includes(0)) return bytes;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return bytes;
	}
	const reencoded = new TextEncoder().encode(text);
	if (reencoded.length !== bytes.length) return bytes;
	for (let i = 0; i < bytes.length; i++) {
		if (reencoded[i] !== bytes[i]) return bytes;
	}
	return isArtifact ? new ImmutableString(text) : text;
}

export function contentToBytes(content: Content): Uint8Array {
	if (typeof content === "string") return new TextEncoder().encode(content);
	if (isImmutableString(content)) {
		return new TextEncoder().encode(String(content));
	}
	return content instanceof Uint8Array ? content : new Uint8Array(content);
}

export function contentEquals(a: Content, b: Content): boolean {
	const av = a instanceof Uint8Array ? a : contentToBytes(a);
	const bv = b instanceof Uint8Array ? b : contentToBytes(b);
	if (av.length !== bv.length) return false;
	for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
	return true;
}

export function makeFileEntry(
	relativePath: string,
	bytes: Uint8Array,
	isArtifact: boolean,
): UnixFileEntry {
	const name = path.posix.basename(relativePath);
	const ext = path.posix.extname(name).replace(/^\./, "");
	return {
		"@patchwork": { type: "file" },
		content: bytesToContent(bytes, isArtifact),
		extension: ext,
		mimeType: mime.lookup(name) || "application/octet-stream",
		name,
	};
}

export function readFileEntry(handle: DocHandle<unknown>): {
	bytes: Uint8Array;
	entry: UnixFileEntry;
} {
	const doc = handle.doc() as Partial<UnixFileEntry> | undefined;
	if (!doc || typeof doc !== "object" || !("content" in doc)) {
		throw new Error(`document ${handle.url} is not a UnixFileEntry`);
	}
	const entry = doc as UnixFileEntry;
	return { bytes: contentToBytes(entry.content), entry };
}

export async function findFileEntry(
	repo: Repo,
	url: AutomergeUrl,
): Promise<{ handle: DocHandle<UnixFileEntry>; bytes: Uint8Array }> {
	const handle = await repo.find<UnixFileEntry>(url);
	const { bytes } = readFileEntry(handle as DocHandle<unknown>);
	return { handle, bytes };
}

export function stripHeads(url: AutomergeUrl): AutomergeUrl {
	const { documentId } = parseAutomergeUrl(url);
	return stringifyAutomergeUrl({ documentId });
}

export function pinUrl(handle: DocHandle<unknown>): AutomergeUrl {
	const { documentId } = parseAutomergeUrl(handle.url);
	return stringifyAutomergeUrl({ documentId, heads: handle.heads() });
}

export function normalizeArtifactDir(dir: string): string {
	let out = dir.replace(/\\/g, "/");
	while (out.startsWith("./")) out = out.slice(2);
	while (out.endsWith("/")) out = out.slice(0, -1);
	return out;
}

export function isInArtifactDir(
	posixPath: string,
	artifactDirs: readonly string[],
): boolean {
	for (const d of artifactDirs) {
		if (!d) continue;
		if (posixPath === d) return true;
		if (posixPath.startsWith(d + "/")) return true;
	}
	return false;
}
