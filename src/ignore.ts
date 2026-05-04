import * as fs from "fs/promises";
import * as path from "path";
import ignore, { type Ignore } from "ignore";
import { log } from "./log.js";

const dlog = log("ignore");

export const ALWAYS_IGNORE = [".pushwork", ".git", "node_modules"];
export const IGNORE_FILE = ".pushworkignore";

export async function loadIgnore(root: string): Promise<Ignore> {
	const ig = ignore().add(ALWAYS_IGNORE);
	dlog("always-ignored: %o", ALWAYS_IGNORE);
	try {
		const text = await fs.readFile(path.join(root, IGNORE_FILE), "utf8");
		const patterns = text
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#"));
		ig.add(patterns);
		dlog("loaded %d patterns from %s", patterns.length, IGNORE_FILE);
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code !== "ENOENT") throw err;
		dlog("no %s in %s", IGNORE_FILE, root);
	}
	return ig;
}

export function isIgnored(ig: Ignore, relativePath: string): boolean {
	if (relativePath === "" || relativePath === ".") return false;
	return ig.ignores(relativePath);
}
