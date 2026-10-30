/**
 * Unit tests for JSON documents (`src/shapes/json.ts`): which files qualify,
 * the structural patch, and the layout-preserving serializer.
 */
import { describe, it, expect } from "vitest";
import * as Automerge from "@automerge/automerge";
import {
	formatJson,
	jsonDocumentOf,
	jsonLinkType,
	jsonValueOf,
	patchJson,
	type JsonObject,
} from "../../src/shapes/json.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** A value as it comes back out of Automerge: keys sorted. */
const throughAutomerge = (value: JsonObject): JsonObject =>
	jsonValueOf(Automerge.from(value));

/** Apply `target` to a fresh fork of `base`, as a separate peer would. */
function forkAndPatch(
	base: Automerge.Doc<JsonObject>,
	target: JsonObject,
): Automerge.Doc<JsonObject> {
	const fork = Automerge.load<JsonObject>(Automerge.save(base));
	return Automerge.change(fork, (d) => patchJson(d, target));
}

describe("jsonDocumentOf", () => {
	it("accepts a .json object whose @patchwork.type isn't file", () => {
		const text = '{"@patchwork":{"type":"stock-flow-model"},"title":"t"}';
		expect(jsonDocumentOf("model/model.json", enc(text))).toEqual({
			"@patchwork": { type: "stock-flow-model" },
			title: "t",
		});
		expect(jsonDocumentOf("A.JSON", enc('{"@patchwork":{}}'))).toEqual({
			"@patchwork": {},
		});
	});

	it("rejects everything else", () => {
		const cases: [string, string][] = [
			["package.json", '{"name":"x"}'],
			["f.json", '{"@patchwork":{"type":"file"},"content":""}'],
			["f.json", '{"@patchwork":"stock-flow-model"}'],
			["f.json", '[{"@patchwork":{"type":"x"}}]'],
			["f.json", '{"@patchwork":{"type":"x"}'],
			["f.txt", '{"@patchwork":{"type":"x"}}'],
		];
		for (const [p, text] of cases) {
			expect(jsonDocumentOf(p, enc(text))).toBeUndefined();
		}
	});
});

describe("jsonLinkType", () => {
	it("uses the doc's own type unless pushwork or Patchwork reserve it", () => {
		expect(jsonLinkType({ "@patchwork": { type: "stock-flow-model" } })).toBe(
			"stock-flow-model",
		);
		for (const type of ["file", "folder", "directory", "branches"]) {
			expect(jsonLinkType({ "@patchwork": { type } })).toBeUndefined();
		}
		expect(jsonLinkType({ title: "x" })).toBeUndefined();
	});
});

describe("formatJson", () => {
	it("reproduces a file's layout byte for byte when its value is unchanged", () => {
		const original = {
			"@patchwork": { type: "m" },
			title: "t",
			variables: { z: { label: "Z", inflows: ["b", "a"] }, a: { label: "A" } },
		};
		for (const text of [
			JSON.stringify(original, null, 1) + "\n",
			JSON.stringify(original, null, "\t"),
			JSON.stringify(original),
			(JSON.stringify(original, null, 2) + "\n").replace(/\n/g, "\r\n"),
		]) {
			const value = throughAutomerge(JSON.parse(text));
			expect(dec(formatJson(value, enc(text)))).toBe(text);
		}
	});

	it("keeps the template's key order and puts new keys after it", () => {
		const template = enc('{\n "b": 1,\n "a": 2\n}\n');
		expect(dec(formatJson({ a: 3, b: 1, c: 4 }, template))).toBe(
			'{\n "b": 1,\n "a": 3,\n "c": 4\n}\n',
		);
	});

	it("defaults to two-space indent and a trailing newline", () => {
		expect(dec(formatJson({ a: [1] }))).toBe('{\n  "a": [\n    1\n  ]\n}\n');
	});
});

describe("patchJson", () => {
	it("makes the doc equal the target", () => {
		const target: JsonObject = {
			"@patchwork": { type: "m" },
			kept: "same",
			changed: "after",
			list: [1, { x: "y2" }, 4, 5],
			added: { deep: [true, null] },
			retyped: [1],
		};
		const doc = Automerge.change(
			Automerge.from<JsonObject>({
				"@patchwork": { type: "m" },
				kept: "same",
				changed: "before",
				list: [1, { x: "y" }, 3],
				removed: 1,
				retyped: "scalar",
			}),
			(d) => patchJson(d, target),
		);
		expect(jsonValueOf(doc)).toEqual(throughAutomerge(target));
	});

	it("records nothing when the value already matches", () => {
		const doc = Automerge.from<JsonObject>({ a: { b: [1, "x"] } });
		const after = Automerge.change(doc, (d) => patchJson(d, { a: { b: [1, "x"] } }));
		expect(Automerge.getHeads(after)).toEqual(Automerge.getHeads(doc));
	});

	it("merges concurrent edits to different keys, array ends and one string", () => {
		const base = Automerge.from<JsonObject>({
			a: 1,
			b: "hello",
			list: [1, 2, 3],
			nested: { keep: true, x: 1 },
		});
		const left = forkAndPatch(base, {
			a: 2,
			b: "well hello",
			list: [0, 1, 2, 3],
			nested: { keep: true, x: 1 },
		});
		const right = forkAndPatch(base, {
			a: 1,
			b: "hello world",
			list: [1, 2, 3, 4],
			nested: { keep: true, x: 2, y: 3 },
		});
		expect(jsonValueOf(Automerge.merge(left, right))).toEqual({
			a: 2,
			b: "well hello world",
			list: [0, 1, 2, 3, 4],
			nested: { keep: true, x: 2, y: 3 },
		});
	});
});
