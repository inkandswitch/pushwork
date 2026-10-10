import * as path from "path";
import mime from "mime-types";
import { ImmutableString, isImmutableString, updateText } from "@automerge/automerge";
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

// a linked doc that isn't a file (a tldraw board, say) has no content and becomes an empty file
export function contentToBytes(content: Content | undefined): Uint8Array {
	if (typeof content === "string") return new TextEncoder().encode(content);
	if (isImmutableString(content)) return new TextEncoder().encode(String(content));
	return content ?? new Uint8Array();
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

// pass to docs.change: text is merged with updateText, bytes and ImmutableString are replaced
export function applyFileEntry(d: UnixFileEntry, fresh: UnixFileEntry): void {
	if (!contentEquals(d.content, fresh.content)) {
		if (typeof d.content === "string" && typeof fresh.content === "string") {
			updateText(d, ["content"], fresh.content);
		} else {
			d.content = fresh.content;
		}
	}
	if (d.extension !== fresh.extension) d.extension = fresh.extension;
	if (d.mimeType !== fresh.mimeType) d.mimeType = fresh.mimeType;
	if (d.name !== fresh.name) d.name = fresh.name;
	if (!d["@patchwork"]) d["@patchwork"] = { type: "file" };
}

export function readFileEntry(doc: unknown): {
	bytes: Uint8Array;
	entry: UnixFileEntry;
} {
	if (!doc || typeof doc !== "object" || !("content" in doc)) {
		throw new Error("document is not a UnixFileEntry");
	}
	const entry = doc as UnixFileEntry;
	return { bytes: contentToBytes(entry.content), entry };
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
