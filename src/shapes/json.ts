import * as Automerge from "@automerge/automerge";
import { byteEq } from "../fs-tree.js";
import { contentToBytes } from "./file.js";
import type { UnixFileEntry } from "./types.js";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** What a leaf doc holds, as the sync engine compares it against disk. File
 * docs carry their bytes; JSON documents carry their value, plus the bytes
 * of its default serialization for byte-oriented consumers. */
export type LeafContent = { bytes: Uint8Array; value?: JsonObject };

/** `@patchwork.type`s that mean something structural to pushwork or
 * Patchwork; a JSON document claiming one of them is linked by extension. */
const RESERVED_TYPES = new Set(["file", "folder", "directory", "branches"]);

const DEFAULT_INDENT = "  ";

/**
 * The value to store as a JSON document for a working-tree file, or
 * undefined when the file should stay a plain `UnixFileEntry`. A file
 * qualifies when it is a `.json` file holding a JSON object whose
 * `@patchwork` field is an object with a `type` other than `"file"` — i.e.
 * it already says which Patchwork datatype it is.
 */
export function jsonDocumentOf(
	posixPath: string,
	bytes: Uint8Array,
): JsonObject | undefined {
	if (!posixPath.toLowerCase().endsWith(".json")) return undefined;
	const value = parseJsonObject(bytes);
	if (!value) return undefined;
	const meta = value["@patchwork"];
	if (!isJsonObject(meta) || meta.type === "file") return undefined;
	return value;
}

/** Read a leaf doc: a `UnixFileEntry` yields its content bytes, anything
 * else is a JSON document and yields its value. */
export function leafContent(doc: unknown): LeafContent {
	if (isFileEntryDoc(doc)) {
		return { bytes: contentToBytes((doc as UnixFileEntry).content) };
	}
	const value = jsonValueOf(doc);
	return { bytes: formatJson(value), value };
}

/** Whether `disk` holds what `leaf` holds: the same bytes for a file doc,
 * the same JSON value (formatting aside) for a JSON document. */
export function leafMatchesDisk(
	leaf: LeafContent,
	disk: Uint8Array | undefined,
): boolean {
	if (!disk) return false;
	if (!leaf.value) return byteEq(disk, leaf.bytes);
	const parsed = parseJsonObject(disk);
	return parsed !== undefined && jsonEquals(leaf.value, parsed);
}

export function isFileEntryDoc(doc: unknown): boolean {
	if (!isRecord(doc) || !("content" in doc)) return false;
	const meta = doc["@patchwork"];
	return meta === undefined || (isRecord(meta) && meta.type === "file");
}

/** The folder-link `type` for a JSON document: its own `@patchwork.type`,
 * so Patchwork opens it with the matching tool. */
export function jsonLinkType(doc: unknown): string | undefined {
	if (!isRecord(doc)) return undefined;
	const meta = doc["@patchwork"];
	if (!isRecord(meta)) return undefined;
	const type = meta.type;
	return typeof type === "string" && !RESERVED_TYPES.has(type)
		? type
		: undefined;
}

/**
 * Mutate `doc` (inside a change callback) until its JSON value equals
 * `target`, touching only what differs: removed keys are deleted, strings
 * are spliced with `Automerge.updateText`, and arrays keep their common
 * prefix and suffix. Concurrent edits to different keys therefore merge.
 */
export function patchJson(doc: JsonObject, target: JsonObject): void {
	patchObject(doc, doc, [], jsonValueOf(doc), target);
}

/**
 * Serialize `value`. When `template` (the file currently on disk) is given,
 * its indentation, line endings, trailing newline and key order are reused,
 * so a rewrite changes only the lines whose values changed. Keys the
 * template doesn't have go after the ones it does.
 */
export function formatJson(value: JsonObject, template?: Uint8Array): Uint8Array {
	const layout = template ? layoutOf(template) : undefined;
	const ordered = layout?.value ? orderLike(value, layout.value) : value;
	const indent = layout ? layout.indent : DEFAULT_INDENT;
	let text = JSON.stringify(ordered, null, indent);
	if (layout ? layout.trailingNewline : true) text += "\n";
	if (layout?.crlf) text = text.replace(/\n/g, "\r\n");
	return new TextEncoder().encode(text);
}

export function parseJsonObject(bytes: Uint8Array): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		);
		return isJsonObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
	if (a === b) return true;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		return a.every((v, i) => jsonEquals(v, b[i]));
	}
	if (isJsonObject(a)) {
		if (!isJsonObject(b)) return false;
		const keys = Object.keys(a);
		if (keys.length !== Object.keys(b).length) return false;
		return keys.every((k) => hasOwn(b, k) && jsonEquals(a[k], b[k]));
	}
	return false;
}

/** The plain JSON value of an Automerge doc (or a proxy inside a change):
 * text becomes strings, counters numbers, dates ISO strings. */
export function jsonValueOf(doc: unknown): JsonObject {
	return JSON.parse(JSON.stringify(doc ?? {})) as JsonObject;
}

type Path = (string | number)[];
type Container = Record<string | number, unknown>;

function patchObject(
	root: JsonObject,
	node: Container,
	path: Path,
	current: JsonObject,
	next: JsonObject,
): void {
	for (const key of Object.keys(current)) {
		if (!hasOwn(next, key)) delete node[key];
	}
	for (const [key, value] of Object.entries(next)) {
		const existing = hasOwn(current, key) ? current[key] : undefined;
		patchSlot(root, node, [...path, key], key, existing, value);
	}
}

function patchArray(
	root: JsonObject,
	node: unknown[],
	path: Path,
	current: JsonValue[],
	next: JsonValue[],
): void {
	let start = 0;
	while (
		start < current.length &&
		start < next.length &&
		jsonEquals(current[start], next[start])
	) {
		start++;
	}
	let currentEnd = current.length;
	let nextEnd = next.length;
	while (
		currentEnd > start &&
		nextEnd > start &&
		jsonEquals(current[currentEnd - 1], next[nextEnd - 1])
	) {
		currentEnd--;
		nextEnd--;
	}
	const paired = Math.min(currentEnd - start, nextEnd - start);
	for (let i = start; i < start + paired; i++) {
		patchSlot(root, node as unknown as Container, [...path, i], i, current[i], next[i]);
	}
	const at = start + paired;
	if (currentEnd > at) node.splice(at, currentEnd - at);
	else if (nextEnd > at) node.splice(at, 0, ...next.slice(at, nextEnd));
}

function patchSlot(
	root: JsonObject,
	parent: Container,
	path: Path,
	key: string | number,
	current: JsonValue | undefined,
	next: JsonValue,
): void {
	if (current !== undefined && jsonEquals(current, next)) return;
	const live = parent[key];
	if (isJsonObject(current) && isJsonObject(next) && isRecord(live)) {
		patchObject(root, live as Container, path, current, next);
	} else if (Array.isArray(current) && Array.isArray(next) && Array.isArray(live)) {
		patchArray(root, live, path, current, next);
	} else if (typeof live === "string" && typeof next === "string") {
		Automerge.updateText(root, path, next);
	} else {
		parent[key] = next;
	}
}

type Layout = {
	value?: JsonValue;
	indent: string;
	trailingNewline: boolean;
	crlf: boolean;
};

function layoutOf(template: Uint8Array): Layout | undefined {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(template);
	} catch {
		return undefined;
	}
	let value: JsonValue | undefined;
	try {
		value = JSON.parse(text) as JsonValue;
	} catch {
		value = undefined;
	}
	const body = text.trimEnd();
	return {
		value,
		indent: body.includes("\n") ? (/\n([ \t]+)\S/.exec(body)?.[1] ?? "") : "",
		trailingNewline: text.endsWith("\n"),
		crlf: text.includes("\r\n"),
	};
}

function orderLike(value: JsonValue, template: JsonValue | undefined): JsonValue {
	if (Array.isArray(value)) {
		const items = Array.isArray(template) ? template : [];
		return value.map((v, i) => orderLike(v, items[i]));
	}
	if (!isJsonObject(value)) return value;
	const shape = isJsonObject(template) ? template : {};
	const out: JsonObject = {};
	for (const key of Object.keys(shape)) {
		if (hasOwn(value, key)) out[key] = orderLike(value[key], shape[key]);
	}
	for (const key of Object.keys(value)) {
		if (!hasOwn(out, key)) out[key] = orderLike(value[key], undefined);
	}
	return out;
}

function isJsonObject(value: unknown): value is JsonObject {
	return isRecord(value) && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const hasOwn = (o: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(o, key);
