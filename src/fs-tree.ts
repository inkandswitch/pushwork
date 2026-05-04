import * as fs from "fs/promises";
import * as path from "path";
import type { Ignore } from "ignore";
import { isIgnored } from "./ignore.js";
import { log } from "./log.js";

const dlog = log("fs-tree");

export type FileTree = Map<string, Uint8Array>;

const toPosix = (p: string) => p.split(path.sep).join("/");

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
	for (const name of names) {
		const full = path.join(current, name);
		const rel = toPosix(path.relative(root, full));
		if (isIgnored(ig, rel)) {
			dlog("skip ignored: %s", rel);
			continue;
		}
		let stat;
		try {
			stat = await fs.lstat(full);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			await walk(root, full, ig, tree);
		} else if (stat.isFile()) {
			const bytes = await fs.readFile(full);
			tree.set(rel, new Uint8Array(bytes));
		}
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

