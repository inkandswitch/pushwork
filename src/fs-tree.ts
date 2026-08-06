import * as fs from "fs/promises";
import * as path from "path";
import type { Ignore } from "ignore";
import { isIgnored } from "./ignore.js";
import { log } from "./log.js";
import { FS_CONCURRENCY, pooled } from "./pool.js";

const dlog = log("fs-tree");

/**
 * Identity of a file's bytes as far as the filesystem can tell, without
 * reading them. Same fields git's index uses to skip re-hashing: any of them
 * moving means the content may have changed. Nanosecond timestamps and the
 * inode are BigInt in Node's `stat`, stored as decimal strings so the whole
 * signature survives JSON.
 */
export type StatSig = {
	size: number;
	mtimeNs: string;
	ctimeNs: string;
	ino: string;
};

/** A file in the working tree. `read` is memoized, so unused entries cost nothing. */
export type FsEntry = {
	stat: StatSig;
	read(): Promise<Uint8Array>;
};

export type FileTree = Map<string, FsEntry>;

const toPosix = (p: string) => p.split(path.sep).join("/");

export function statSigsEqual(a: StatSig, b: StatSig): boolean {
	return (
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs &&
		a.ino === b.ino
	);
}

/**
 * Stat every non-ignored file under `root`. Bytes are read lazily — callers
 * that only need to know a file is unchanged never touch the disk for it.
 */
export async function walkDir(root: string, ig: Ignore): Promise<FileTree> {
	dlog("walkDir root=%s", root);
	const tree: FileTree = new Map();
	await walk(root, root, ig, tree);
	dlog("walkDir done: %d files", tree.size);
	return tree;
}

async function walk(
	root: string,
	current: string,
	ig: Ignore,
	tree: FileTree,
): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(current);
	} catch {
		return;
	}
	await pooled(names, FS_CONCURRENCY, async (name) => {
		const full = path.join(current, name);
		const rel = toPosix(path.relative(root, full));
		if (isIgnored(ig, rel)) {
			dlog("skip ignored: %s", rel);
			return;
		}
		let stat;
		try {
			stat = await fs.stat(full, { bigint: true });
		} catch {
			return;
		}
		if (stat.isDirectory()) {
			await walk(root, full, ig, tree);
		} else if (stat.isFile()) {
			tree.set(rel, fileEntry(full, stat));
		}
	});
}

type BigIntStat = {
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
	ino: bigint;
};

const toSig = (stat: BigIntStat): StatSig => ({
	size: Number(stat.size),
	mtimeNs: stat.mtimeNs.toString(),
	ctimeNs: stat.ctimeNs.toString(),
	ino: stat.ino.toString(),
});

function fileEntry(full: string, stat: BigIntStat): FsEntry {
	let pending: Promise<Uint8Array> | undefined;
	return {
		stat: toSig(stat),
		read: () =>
			(pending ??= fs.readFile(full).then((b) => new Uint8Array(b))),
	};
}

/** Stat one file, e.g. straight after writing it. Undefined if it's gone. */
export async function statSig(full: string): Promise<StatSig | undefined> {
	try {
		return toSig(await fs.stat(full, { bigint: true }));
	} catch {
		return undefined;
	}
}

export function byteEq(a: Uint8Array | undefined, b: Uint8Array): boolean {
	if (!a) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export async function writeFileAtomic(
	target: string,
	bytes: Uint8Array,
): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, bytes);
}
