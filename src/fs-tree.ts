import * as fs from "fs/promises";
import * as path from "path";
import type { Ignore } from "ignore";
import { isIgnored } from "./ignore.js";

export type FileTree = Map<string, Uint8Array>;

const toPosix = (p: string) => p.split(path.sep).join("/");
const fromPosix = (p: string) => p.split("/").join(path.sep);

export async function walkDir(root: string, ig: Ignore): Promise<FileTree> {
	const tree: FileTree = new Map();
	await walk(root, root, ig, tree);
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
		if (isIgnored(ig, rel)) continue;
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

export async function materialize(
	root: string,
	docFiles: Record<string, Uint8Array>,
	currentFiles: FileTree,
): Promise<void> {
	for (const [rel, bytes] of Object.entries(docFiles)) {
		const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		if (byteEq(currentFiles.get(rel), view)) continue;
		await writeFileAtomic(path.join(root, fromPosix(rel)), view);
	}
	for (const rel of currentFiles.keys()) {
		if (!(rel in docFiles)) {
			try {
				await fs.unlink(path.join(root, fromPosix(rel)));
			} catch {
				// already gone
			}
			await pruneEmptyDirs(root, path.dirname(fromPosix(rel)));
		}
	}
}

async function pruneEmptyDirs(root: string, relDir: string): Promise<void> {
	let dir = relDir;
	while (dir && dir !== "." && dir !== path.sep) {
		const full = path.join(root, dir);
		try {
			const entries = await fs.readdir(full);
			if (entries.length > 0) return;
			await fs.rmdir(full);
		} catch {
			return;
		}
		dir = path.dirname(dir);
	}
}
