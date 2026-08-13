/**
 * Tests for `.pushworkattributes` parsing and matching: gitattributes-style
 * path globs that assign the `artifact` attribute (ImmutableString content).
 * Attributes files may sit in any directory, each scoped to its own subtree,
 * deepest file wins. Fully offline — no repo or network.
 */
import { describe, it, expect } from "vitest";

import { Attributes, attributesTreeOf } from "../../src/attributes.js";

describe("Attributes.parse", () => {
	it("matches directory and glob patterns", () => {
		const a = Attributes.parse(
			["dist/**  artifact", "build/** artifact", "*.wasm   artifact"].join("\n"),
		);
		expect(a.isArtifact("dist/index.js")).toBe(true);
		expect(a.isArtifact("dist/nested/deep/x.js")).toBe(true);
		expect(a.isArtifact("build/out.o")).toBe(true);
		expect(a.isArtifact("pkg/lib.wasm")).toBe(true);
		expect(a.isArtifact("src/index.ts")).toBe(false);
	});

	it("honors last-match-wins negation (-artifact)", () => {
		const a = Attributes.parse(
			["*.wasm     artifact", "vendored/  -artifact"].join("\n"),
		);
		expect(a.isArtifact("a.wasm")).toBe(true);
		// vendored/ unset comes after the *.wasm set, so it wins.
		expect(a.isArtifact("vendored/a.wasm")).toBe(false);
	});

	it("ignores blank lines, comments, and unknown attributes", () => {
		const a = Attributes.parse(
			["", "# a comment", "dist/** artifact linguist-vendored", "*.md text"].join(
				"\n",
			),
		);
		expect(a.isArtifact("dist/x.js")).toBe(true);
		// `*.md text` declares no artifact attribute, so .md is not an artifact.
		expect(a.isArtifact("README.md")).toBe(false);
		expect(a.hasArtifactRules).toBe(true);
	});

	it("reports no artifact rules for an empty or comment-only file", () => {
		expect(Attributes.parse("").hasArtifactRules).toBe(false);
		expect(Attributes.parse("# nothing here\n").hasArtifactRules).toBe(false);
	});
});

describe("attributesTreeOf", () => {
	const enc = (s: string) => new TextEncoder().encode(s);

	it("is empty when no attributes file is in the tree", () => {
		const tree = attributesTreeOf(new Map([["src/a.ts", enc("x")]]));
		expect(tree.hasArtifactRules).toBe(false);
		expect(tree.isArtifact("dist/a.js")).toBe(false);
	});

	it("scopes each file's rules to its own directory", () => {
		const tree = attributesTreeOf(
			new Map([["pkg/.pushworkattributes", enc("dist/** artifact\n")]]),
		);
		expect(tree.hasArtifactRules).toBe(true);
		expect(tree.isArtifact("pkg/dist/index.js")).toBe(true);
		// The rule lives in pkg/, so it says nothing about paths outside it.
		expect(tree.isArtifact("other/dist/index.js")).toBe(false);
		expect(tree.isArtifact("dist/index.js")).toBe(false);
	});

	it("lets a deeper file override a shallower one", () => {
		const tree = attributesTreeOf(
			new Map([
				[".pushworkattributes", enc("**/*.wasm artifact\n")],
				["vendored/.pushworkattributes", enc("*.wasm -artifact\n")],
			]),
		);
		expect(tree.isArtifact("pkg/lib.wasm")).toBe(true);
		expect(tree.isArtifact("vendored/lib.wasm")).toBe(false);
	});

	it("leaves paths a deeper file doesn't mention to the shallower rules", () => {
		const tree = attributesTreeOf(
			new Map([
				[".pushworkattributes", enc("**/dist/** artifact\n")],
				["pkg/.pushworkattributes", enc("*.gen.js artifact\n")],
			]),
		);
		// pkg's file says nothing about dist, so the root rule still applies.
		expect(tree.isArtifact("pkg/dist/a.js")).toBe(true);
		expect(tree.isArtifact("pkg/b.gen.js")).toBe(true);
		expect(tree.isArtifact("pkg/b.js")).toBe(false);
	});
});
