/**
 * Unit tests for the stat cache (`src/stat-cache.ts`) and the fan-out pool
 * (`src/pool.ts`). Fully offline.
 *
 * The cache decides which paths are skipped without reading them, so a false
 * "unchanged" silently drops an edit. These tests pin the conservative
 * direction: anything unknown, moved, or ambiguous must read false.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
	cacheEntry,
	isUnchanged,
	readStatCache,
	writeStatCache,
	type StatCache,
} from "../../src/stat-cache.js";
import { statSigsEqual, type StatSig } from "../../src/fs-tree.js";
import { pooled } from "../../src/pool.js";

const sig = (over: Partial<StatSig> = {}): StatSig => ({
	size: 512,
	mtimeNs: "1700000000000000000",
	ctimeNs: "1700000000000000000",
	ino: "12345",
	...over,
});

describe("isUnchanged", () => {
	const cache: StatCache = new Map([["a.txt", cacheEntry(sig(), ["h1", "h2"])]]);

	it("is true when both the stat signature and the heads still match", () => {
		expect(isUnchanged(cache, "a.txt", sig(), ["h1", "h2"])).toBe(true);
	});

	it("is false for a path it has never seen", () => {
		expect(isUnchanged(cache, "b.txt", sig(), ["h1", "h2"])).toBe(false);
	});

	it("is false when any stat field moved", () => {
		for (const over of [
			{ size: 513 },
			{ mtimeNs: "1700000000000000001" },
			{ ctimeNs: "1700000000000000001" },
			{ ino: "12346" },
		]) {
			expect(isUnchanged(cache, "a.txt", sig(over), ["h1", "h2"])).toBe(false);
		}
	});

	it("is false when the doc heads moved, even with an untouched file", () => {
		// A change that arrived from a peer: disk is identical, doc is not.
		expect(isUnchanged(cache, "a.txt", sig(), ["h1", "h3"])).toBe(false);
		expect(isUnchanged(cache, "a.txt", sig(), ["h1"])).toBe(false);
		expect(isUnchanged(cache, "a.txt", sig(), ["h1", "h2", "h3"])).toBe(false);
		expect(isUnchanged(cache, "a.txt", sig(), [])).toBe(false);
	});
});

describe("statSigsEqual", () => {
	it("compares every field", () => {
		expect(statSigsEqual(sig(), sig())).toBe(true);
		expect(statSigsEqual(sig(), sig({ size: 0 }))).toBe(false);
	});
});

describe("readStatCache / writeStatCache", () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-cache-"));
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const cacheFile = () => path.join(root, ".pushwork", "stat-cache.json");

	it("round-trips entries written well before the write timestamp", async () => {
		const cache: StatCache = new Map([
			["a.txt", cacheEntry(sig(), ["h1"])],
			["dir/b.bin", cacheEntry(sig({ ino: "999" }), ["h2", "h3"])],
		]);
		await writeStatCache(root, cache);
		const back = await readStatCache(root);
		expect(back.get("a.txt")).toEqual(cache.get("a.txt"));
		expect(back.get("dir/b.bin")).toEqual(cache.get("dir/b.bin"));
	});

	it("drops racily-clean entries — mtime at or after the write", async () => {
		// An mtime far in the future stands in for a file modified inside the
		// same timestamp tick as the cache write: its signature can't be trusted.
		const future = (BigInt(Date.now() + 60_000) * 1_000_000n).toString();
		await writeStatCache(
			root,
			new Map([
				["stale.txt", cacheEntry(sig(), ["h1"])],
				["racy.txt", cacheEntry(sig({ mtimeNs: future }), ["h2"])],
			]),
		);
		const back = await readStatCache(root);
		expect(back.has("stale.txt")).toBe(true);
		expect(back.has("racy.txt")).toBe(false);
	});

	it("is empty when there is no cache file", async () => {
		expect((await readStatCache(root)).size).toBe(0);
	});

	it("is empty on unparseable or unrecognized contents", async () => {
		for (const body of [
			"not json at all",
			"null",
			JSON.stringify({ version: 999, writtenNs: "1", entries: {} }),
			JSON.stringify({ version: 1, entries: {} }),
			JSON.stringify({ version: 1, writtenNs: "1" }),
		]) {
			await fs.mkdir(path.dirname(cacheFile()), { recursive: true });
			await fs.writeFile(cacheFile(), body);
			expect((await readStatCache(root)).size).toBe(0);
		}
	});

	it("does not throw when the cache cannot be written", async () => {
		// A file where the .pushwork directory should be: mkdir fails, and the
		// cache is only ever an optimization.
		await fs.writeFile(path.join(root, ".pushwork"), "");
		await expect(
			writeStatCache(root, new Map([["a.txt", cacheEntry(sig(), ["h1"])]])),
		).resolves.toBeUndefined();
	});
});

describe("pooled", () => {
	it("preserves input order regardless of completion order", async () => {
		const out = await pooled([30, 10, 20, 0], 2, async (ms) => {
			await new Promise((r) => setTimeout(r, ms));
			return ms;
		});
		expect(out).toEqual([30, 10, 20, 0]);
	});

	it("never exceeds the concurrency limit", async () => {
		let live = 0;
		let peak = 0;
		await pooled(Array.from({ length: 50 }, (_, i) => i), 4, async () => {
			live++;
			peak = Math.max(peak, live);
			await new Promise((r) => setTimeout(r, 1));
			live--;
		});
		expect(peak).toBeLessThanOrEqual(4);
		expect(peak).toBeGreaterThan(1);
	});

	it("handles an empty input", async () => {
		expect(await pooled([], 8, async () => 1)).toEqual([]);
	});
});
