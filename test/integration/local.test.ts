/**
 * Black-box integration tests for the local-only commands: save (offline
 * commit), status, diff. These never need to contact a sync server.
 *
 * `init` does a brief network roundtrip (waitForSync with a 3s floor on
 * init), but everything else here is offline.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execFile } from "child_process";
import { promisify } from "util";
import { CONFIG_VERSION } from "../../src/config.js";

const execFileP = promisify(execFile);
const CLI = path.join(__dirname, "..", "..", "dist", "cli.js");

const TEST_TIMEOUT = 60_000;

async function pushwork(
	args: string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
	try {
		return await execFileP("node", [CLI, ...args], {
			cwd,
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
			timeout: 45_000,
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch (err: any) {
		const detail = [
			`pushwork ${args.join(" ")} failed (cwd=${cwd ?? process.cwd()})`,
			err.message,
			err.stdout ? `stdout: ${err.stdout}` : "",
			err.stderr ? `stderr: ${err.stderr}` : "",
		]
			.filter(Boolean)
			.join("\n");
		throw new Error(detail);
	}
}

async function readText(p: string): Promise<string> {
	return fs.readFile(p, "utf8");
}

// dist/ is built once by test/global-setup.ts.

describe("pushwork local-only commands", () => {
	let workRoot: string;
	let cleanup: () => void;

	beforeEach(() => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		workRoot = t.name;
		cleanup = t.removeCallback;
	});

	afterEach(() => cleanup());

	async function initRepo(args: string[] = []): Promise<string> {
		await fs.writeFile(path.join(workRoot, "a.txt"), "hello\n");
		await pushwork(["init", ...args], workRoot);
		return workRoot;
	}

	describe("status", () => {
		it(
			"is clean immediately after init",
			async () => {
				await initRepo();
				const { stdout } = await pushwork(["status"], workRoot);
				expect(stdout).toContain("nothing to save");
			},
			TEST_TIMEOUT,
		);

		it(
			"reports added/modified/deleted",
			async () => {
				await initRepo();
				await fs.writeFile(path.join(workRoot, "a.txt"), "edited\n");
				await fs.writeFile(path.join(workRoot, "added.txt"), "new\n");
				await fs.writeFile(path.join(workRoot, "doomed.txt"), "delete me\n");
				await pushwork(["save"], workRoot);
				await fs.unlink(path.join(workRoot, "doomed.txt"));
				await fs.writeFile(path.join(workRoot, "a.txt"), "edited again\n");
				await fs.writeFile(path.join(workRoot, "another.txt"), "new2\n");

				const { stdout } = await pushwork(["status"], workRoot);
				expect(stdout).toContain("modified:   a.txt");
				expect(stdout).toContain("added:      another.txt");
				expect(stdout).toContain("deleted:    doomed.txt");
			},
			TEST_TIMEOUT,
		);
	});

	describe("save (offline commit)", () => {
		it(
			"clears status without contacting any sync server",
			async () => {
				await initRepo();
				await fs.writeFile(path.join(workRoot, "b.txt"), "two\n");
				const before = (await pushwork(["status"], workRoot)).stdout;
				expect(before).toContain("added:      b.txt");

				// Point at deliberately unreachable endpoints so a network call
				// would visibly fail. save must succeed regardless.
				const env = {
					...process.env,
					PUSHWORK_LEGACY_SERVER: "wss://127.0.0.1:1/never",
					PUSHWORK_SUBDUCTION_SERVER: "wss://127.0.0.1:1/never",
					FORCE_COLOR: "0",
					NO_COLOR: "1",
				};
				await execFileP("node", [CLI, "save"], {
					cwd: workRoot,
					env,
					timeout: 30_000,
				});

				const after = (await pushwork(["status"], workRoot)).stdout;
				expect(after).toContain("nothing to save");
			},
			TEST_TIMEOUT,
		);

		it(
			"`commit` is an alias for save",
			async () => {
				await initRepo();
				await fs.writeFile(path.join(workRoot, "c.txt"), "c\n");
				await pushwork(["commit"], workRoot);
				const { stdout } = await pushwork(["status"], workRoot);
				expect(stdout).toContain("nothing to save");
			},
			TEST_TIMEOUT,
		);
	});

	describe("diff", () => {
		it(
			"shows a unified diff for modified files",
			async () => {
				await initRepo();
				await fs.writeFile(path.join(workRoot, "a.txt"), "hello world\n");
				const { stdout } = await pushwork(["diff"], workRoot);
				expect(stdout).toContain("-hello");
				expect(stdout).toContain("+hello world");
			},
			TEST_TIMEOUT,
		);

		it(
			"prints (no changes) when clean",
			async () => {
				await initRepo();
				const { stdout } = await pushwork(["diff"], workRoot);
				expect(stdout.trim()).toBe("(no changes)");
			},
			TEST_TIMEOUT,
		);
	});

	describe("config", () => {
		it(
			"records the current config version and no branches field",
			async () => {
				await initRepo();
				const cfg = JSON.parse(
					await readText(path.join(workRoot, ".pushwork", "config.json")),
				);
				expect(cfg.version).toBe(CONFIG_VERSION);
				expect(cfg.branches).toBeUndefined();
			},
			TEST_TIMEOUT,
		);

		it(
			"defaults backend to subduction",
			async () => {
				await initRepo();
				const cfg = JSON.parse(
					await readText(path.join(workRoot, ".pushwork", "config.json")),
				);
				expect(cfg.backend).toBe("subduction");
			},
			TEST_TIMEOUT,
		);

		it(
			"--legacy switches to the legacy backend",
			async () => {
				await initRepo(["--legacy"]);
				const cfg = JSON.parse(
					await readText(path.join(workRoot, ".pushwork", "config.json")),
				);
				expect(cfg.backend).toBe("legacy");
			},
			TEST_TIMEOUT,
		);

		it(
			"--no-sub switches to the legacy backend (alias)",
			async () => {
				await initRepo(["--no-sub"]);
				const cfg = JSON.parse(
					await readText(path.join(workRoot, ".pushwork", "config.json")),
				);
				expect(cfg.backend).toBe("legacy");
			},
			TEST_TIMEOUT,
		);
	});
});
