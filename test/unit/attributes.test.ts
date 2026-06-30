/**
 * Tests for `.pushworkattributes` parsing and matching: gitattributes-style
 * path globs that assign the `artifact` attribute (immutable, heads-pinned).
 * Fully offline — no repo or network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";

import {
	Attributes,
	readAttributes,
	ATTRIBUTES_FILE,
} from "../../src/attributes.js";

tmp.setGracefulCleanup();

let root: string;
let cleanup: () => void;

beforeEach(() => {
	const d = tmp.dirSync({ unsafeCleanup: true });
	root = d.name;
	cleanup = d.removeCallback;
});

afterEach(() => cleanup());

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

describe("readAttributes", () => {
	it("returns null when the file is absent", async () => {
		expect(await readAttributes(root)).toBeNull();
	});

	it("reads and parses the file when present", async () => {
		await fs.writeFile(
			path.join(root, ATTRIBUTES_FILE),
			"out/** artifact\n",
			"utf8",
		);
		const a = await readAttributes(root);
		expect(a).not.toBeNull();
		expect(a!.isArtifact("out/bundle.js")).toBe(true);
		expect(a!.isArtifact("src/a.ts")).toBe(false);
	});
});
