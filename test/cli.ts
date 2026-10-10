import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";

const run = promisify(execFile);
const CLI = path.join(__dirname, "..", "dist", "cli.js");

// Run the built CLI (dist/ is built by global-setup).
export async function pushwork(args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
	try {
		return await run("node", [CLI, ...args], {
			cwd,
			env: { ...process.env, ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
			timeout: 30_000,
		});
	} catch (e: any) {
		throw new Error(`pushwork ${args.join(" ")} failed in ${cwd}\n${e.message}\n${e.stdout ?? ""}`);
	}
}

export const readText = (p: string) => fs.readFile(p, "utf8");

export async function exists(p: string): Promise<boolean> {
	return fs.access(p).then(
		() => true,
		() => false,
	);
}

// Every file under dir except .pushwork, with its bytes.
export async function userFiles(dir: string): Promise<Map<string, Buffer>> {
	const out = new Map<string, Buffer>();
	for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
		const full = path.join(e.parentPath, e.name);
		const rel = path.relative(dir, full);
		if (!e.isFile() || rel.split(path.sep)[0] === ".pushwork") continue;
		out.set(rel, await fs.readFile(full));
	}
	return out;
}
