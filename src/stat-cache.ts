import * as fs from "fs/promises";
import * as path from "path";
import { pushworkDir } from "./config.js";
import { statSigsEqual, type StatSig } from "./fs-tree.js";
import { log } from "./log.js";

const dlog = log("stat-cache");

const FILE = "stat-cache.json";
const VERSION = 1;

/**
 * What a path looked like the last time we confirmed its bytes on disk matched
 * its file doc: the filesystem's identity for those bytes, plus the doc heads
 * they matched. Both must still hold for the path to count as unchanged —
 * `heads` alone would miss a local edit, `stat` alone would miss an edit that
 * arrived from a peer.
 */
export type CacheEntry = StatSig & { heads: string[] };

export type StatCache = Map<string, CacheEntry>;

/**
 * Load `.pushwork/stat-cache.json`. Any problem — missing file, bad JSON, an
 * older version — yields an empty cache, which just means the next run reads
 * everything. Entries whose mtime is at or after the moment the cache was
 * written are dropped: the file could have been modified again inside the same
 * timestamp tick, so its signature can't be trusted (git calls these "racily
 * clean").
 */
export async function readStatCache(root: string): Promise<StatCache> {
	let raw: unknown;
	try {
		raw = JSON.parse(await fs.readFile(path.join(pushworkDir(root), FILE), "utf8"));
	} catch {
		dlog("no usable cache at %s", root);
		return new Map();
	}
	if (
		!raw ||
		typeof raw !== "object" ||
		(raw as { version?: unknown }).version !== VERSION
	) {
		return new Map();
	}
	const { writtenNs, entries } = raw as {
		writtenNs?: string;
		entries?: Record<string, CacheEntry>;
	};
	if (!writtenNs || !entries) return new Map();

	const written = BigInt(writtenNs);
	const cache: StatCache = new Map();
	let racy = 0;
	for (const [p, entry] of Object.entries(entries)) {
		if (BigInt(entry.mtimeNs) >= written) {
			racy++;
			continue;
		}
		cache.set(p, entry);
	}
	dlog("loaded %d entries (%d racily clean, dropped)", cache.size, racy);
	return cache;
}

export async function writeStatCache(
	root: string,
	cache: StatCache,
): Promise<void> {
	const body = {
		version: VERSION,
		// Conservative: Date.now() is millisecond-resolution, so this lands at
		// the start of the current millisecond and anything written during it
		// reads back as racily clean.
		writtenNs: (BigInt(Date.now()) * 1_000_000n).toString(),
		entries: Object.fromEntries(cache),
	};
	try {
		await fs.mkdir(pushworkDir(root), { recursive: true });
		await fs.writeFile(
			path.join(pushworkDir(root), FILE),
			JSON.stringify(body),
		);
		dlog("wrote %d entries", cache.size);
	} catch (err) {
		// The cache is an optimization; failing to persist it only costs speed.
		dlog("write failed: %s", err instanceof Error ? err.message : String(err));
	}
}

/**
 * Whether `path` can be treated as identical to its file doc without reading
 * either side. False whenever anything is unknown or has moved.
 */
export function isUnchanged(
	cache: StatCache,
	posixPath: string,
	stat: StatSig,
	heads: readonly string[],
): boolean {
	const entry = cache.get(posixPath);
	if (!entry) return false;
	if (!statSigsEqual(entry, stat)) return false;
	if (entry.heads.length !== heads.length) return false;
	return entry.heads.every((h, i) => h === heads[i]);
}

export const cacheEntry = (
	stat: StatSig,
	heads: readonly string[],
): CacheEntry => ({ ...stat, heads: [...heads] });
