import * as fs from "fs/promises";
import * as path from "path";
import ignore, { type Ignore } from "ignore";

const ALWAYS_IGNORE = [".pushwork", ".git", "node_modules"];

export async function loadIgnore(root: string): Promise<Ignore> {
	const ig = ignore().add(ALWAYS_IGNORE);
	try {
		const text = await fs.readFile(path.join(root, ".gitignore"), "utf8");
		ig.add(text);
	} catch {
		// no .gitignore — fine
	}
	return ig;
}

export function isIgnored(ig: Ignore, relativePath: string): boolean {
	if (relativePath === "" || relativePath === ".") return false;
	return ig.ignores(relativePath);
}
