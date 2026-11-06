import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import { homeEnv } from "./home";

const run = promisify(execFile);
const CLI = path.join(__dirname, "..", "dist", "cli.js");
const FALLBACK = "couldn't start the pushwork daemon";

// homes other than the suite's that commands ran in, each with its own daemon
const homes = new Set<string>();

// Run the built CLI (dist/ is built by global-setup). Commands run in the home's daemon; one
// that fell back to running in the CLI fails, so the suite really tests the daemon.
export async function pushwork(args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
	if (env?.HOME && env.HOME !== process.env.HOME && args[0] !== "daemon") homes.add(env.HOME);
	const result = await run("node", [CLI, ...args], {
		cwd,
		env: { ...process.env, ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
		timeout: 30_000,
	}).catch((e: any) => e);
	// not the output, which a test's expected error might match
	if (`${result.stdout}${result.stderr}`.includes(FALLBACK)) {
		throw new Error(`pushwork ${args.join(" ")} ran without the daemon in ${cwd} (see daemon.log in its home)`);
	}
	if (result instanceof Error) {
		throw new Error(`pushwork ${args.join(" ")} failed in ${cwd}\n${result.message}\n${(result as any).stdout ?? ""}`);
	}
	return result;
}

/** Stop the daemons of the homes commands ran in, other than the suite's. */
export async function stopDaemons(): Promise<void> {
	const stopping = [...homes];
	homes.clear();
	for (const home of stopping) await pushwork(["daemon", "stop"], undefined, homeEnv(home));
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
