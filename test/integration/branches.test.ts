/**
 * Black-box integration tests for branches, save (offline commit), status, and
 * diff.
 *
 * `init` does a brief network roundtrip (waitForSync with a 3s floor on init),
 * but everything else here is offline: save / status / diff / branch / switch /
 * branches all use `repo.openRepo({ offline: true })` and never connect to a
 * sync server.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execFile } from "child_process";
import { promisify } from "util";

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

async function pushworkExpectFail(
	args: string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const ok = await execFileP("node", [CLI, ...args], {
			cwd,
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
			timeout: 45_000,
			maxBuffer: 16 * 1024 * 1024,
		});
		throw new Error(
			`expected failure, got success: stdout=${ok.stdout} stderr=${ok.stderr}`,
		);
	} catch (err: any) {
		if (typeof err.code !== "number") throw err;
		return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code };
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function readText(p: string): Promise<string> {
	return fs.readFile(p, "utf8");
}

beforeAll(async () => {
	await execFileP("pnpm", ["build"], {
		cwd: path.join(__dirname, "..", ".."),
		timeout: 120_000,
	});
}, 120_000);

describe("pushwork branches & offline commands", () => {
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
		await pushwork(["init", "--sub", ...args], workRoot);
		return workRoot;
	}

	describe("init defaults to branches mode", () => {
		it(
			"creates a .pushwork/branch file with 'default'",
			async () => {
				await initRepo();
				expect(await readText(path.join(workRoot, ".pushwork", "branch"))).toBe(
					"default\n",
				);
			},
			TEST_TIMEOUT,
		);

		it(
			"`pushwork branch` prints the current branch",
			async () => {
				await initRepo();
				const { stdout } = await pushwork(["branch"], workRoot);
				expect(stdout.trim()).toBe("default");
			},
			TEST_TIMEOUT,
		);

		it(
			"`pushwork branches` lists the default branch and marks it current",
			async () => {
				await initRepo();
				const { stdout } = await pushwork(["branches"], workRoot);
				expect(stdout).toContain("* default");
			},
			TEST_TIMEOUT,
		);

		it(
			"records branches=true in config.json",
			async () => {
				await initRepo();
				const cfg = JSON.parse(
					await readText(path.join(workRoot, ".pushwork", "config.json")),
				);
				expect(cfg.branches).toBe(true);
				expect(cfg.version).toBe(3);
			},
			TEST_TIMEOUT,
		);
	});

	describe("init --no-branches", () => {
		it(
			"records branches=false and creates no branch file",
			async () => {
				await initRepo(["--no-branches"]);
				const cfg = JSON.parse(
					await readText(path.join(workRoot, ".pushwork", "config.json")),
				);
				expect(cfg.branches).toBe(false);
				expect(
					await pathExists(path.join(workRoot, ".pushwork", "branch")),
				).toBe(false);
			},
			TEST_TIMEOUT,
		);

		it(
			"`pushwork branch` prints (none) without args",
			async () => {
				await initRepo(["--no-branches"]);
				const { stdout } = await pushwork(["branch"], workRoot);
				expect(stdout.trim()).toBe("(none)");
			},
			TEST_TIMEOUT,
		);

		it(
			"`pushwork branches` errors",
			async () => {
				await initRepo(["--no-branches"]);
				const { stderr, code } = await pushworkExpectFail(
					["branches"],
					workRoot,
				);
				expect(stderr).toContain("no branches");
				expect(code).toBe(1);
			},
			TEST_TIMEOUT,
		);
	});

	describe("status", () => {
		it(
			"is clean immediately after init",
			async () => {
				await initRepo();
				const { stdout } = await pushwork(["status"], workRoot);
				expect(stdout).toContain("On branch default");
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

	describe("branch / switch", () => {
		it(
			"branch <name> creates a new branch but doesn't switch",
			async () => {
				await initRepo();
				await pushwork(["branch", "feat"], workRoot);
				expect(
					(await pushwork(["branch"], workRoot)).stdout.trim(),
				).toBe("default");
				expect((await pushwork(["branches"], workRoot)).stdout).toContain(
					"feat",
				);
			},
			TEST_TIMEOUT,
		);

		it(
			"switch <name> materializes the branch's tree",
			async () => {
				await initRepo();
				await pushwork(["branch", "feat"], workRoot);

				// Add a file on default and save
				await fs.writeFile(path.join(workRoot, "default-only.txt"), "D\n");
				await pushwork(["save"], workRoot);

				// Switch to feat: default-only.txt should disappear (feat was branched
				// from default before the save)
				await pushwork(["switch", "feat"], workRoot);
				expect(
					await pathExists(path.join(workRoot, "default-only.txt")),
				).toBe(false);

				// Switch back to default: file reappears
				await pushwork(["switch", "default"], workRoot);
				expect(
					await readText(path.join(workRoot, "default-only.txt")),
				).toBe("D\n");
			},
			TEST_TIMEOUT,
		);

		it(
			"switch refuses with uncommitted changes",
			async () => {
				await initRepo();
				await pushwork(["branch", "feat"], workRoot);
				await fs.writeFile(path.join(workRoot, "dirty.txt"), "uncommitted\n");

				const { stderr, code } = await pushworkExpectFail(
					["switch", "feat"],
					workRoot,
				);
				expect(code).toBe(1);
				expect(stderr).toMatch(/uncommitted changes/);
			},
			TEST_TIMEOUT,
		);

		it(
			"branch <name> errors when name already exists",
			async () => {
				await initRepo();
				await pushwork(["branch", "feat"], workRoot);
				const { stderr } = await pushworkExpectFail(
					["branch", "feat"],
					workRoot,
				);
				expect(stderr).toContain("already exists");
			},
			TEST_TIMEOUT,
		);

		it(
			"switch errors on a non-existent branch",
			async () => {
				await initRepo();
				const { stderr } = await pushworkExpectFail(
					["switch", "nope"],
					workRoot,
				);
				expect(stderr).toMatch(/does not exist/);
			},
			TEST_TIMEOUT,
		);

		it(
			"switch with no name lists branches",
			async () => {
				await initRepo();
				await pushwork(["branch", "feat"], workRoot);
				const { stdout } = await pushwork(["switch"], workRoot);
				expect(stdout).toContain("* default");
				expect(stdout).toContain("feat");
			},
			TEST_TIMEOUT,
		);
	});
});
