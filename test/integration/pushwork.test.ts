/**
 * Integration tests for pushwork.
 *
 * Black-box: drive the CLI as a subprocess, observe filesystem and stdout.
 * No imports from src/ — these tests are the spec for what pushwork does,
 * not how it does it.
 *
 * Run against both supported sync backends:
 *   - "legacy"      → default WebSocket sync server (no flag)
 *   - "subduction"  → --sub flag on init/clone (persisted in config; used
 *                     automatically by subsequent sync runs)
 *
 * Tests hit the public sync servers, so each test allows generous time
 * for network roundtrips.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import * as tmp from "tmp";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);
const CLI = path.join(__dirname, "..", "..", "dist", "cli.js");

const TEST_TIMEOUT = 120_000;

type Backend = { name: string; flags: string[] };
const BACKENDS: Backend[] = [
	{ name: "legacy", flags: [] },
	{ name: "subduction", flags: ["--sub"] },
];

async function pushwork(
	args: string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
	try {
		return await execFileP("node", [CLI, ...args], {
			cwd,
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
			timeout: 90_000,
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

async function listUserFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(current: string) {
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === ".pushwork") continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				out.push(path.relative(dir, full));
			}
		}
	}
	await walk(dir);
	return out.sort();
}

async function hashUserContent(dir: string): Promise<string> {
	const files = await listUserFiles(dir);
	const h = crypto.createHash("sha256");
	for (const f of files) {
		h.update(f);
		h.update("\0");
		h.update(await fs.readFile(path.join(dir, f)));
		h.update("\0");
	}
	return h.digest("hex");
}

async function syncOnce(repos: string[]): Promise<void> {
	for (const r of repos) await pushwork(["sync"], r);
}

async function syncUntilConverged(
	repos: string[],
	maxRounds = 6,
): Promise<number> {
	for (let round = 1; round <= maxRounds; round++) {
		await syncOnce(repos);
		const hashes = await Promise.all(repos.map(hashUserContent));
		if (hashes.every((h) => h === hashes[0])) return round;
	}
	const hashes = await Promise.all(repos.map(hashUserContent));
	const debug = await Promise.all(
		repos.map(async (r, i) => `${i}: ${(await listUserFiles(r)).join(",")}`),
	);
	throw new Error(
		`failed to converge after ${maxRounds} rounds:\n  hashes: ${hashes
			.map((h) => h.slice(0, 12))
			.join(" / ")}\n  files:\n    ${debug.join("\n    ")}`,
	);
}

beforeAll(async () => {
	// Build once for the entire suite.
	await execFileP("pnpm", ["build"], {
		cwd: path.join(__dirname, "..", ".."),
		timeout: 120_000,
	});
}, 120_000);

describe.each(BACKENDS)("pushwork — $name backend", ({ flags }) => {
	let workRoot: string;
	let cleanup: () => void;

	beforeEach(() => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		workRoot = t.name;
		cleanup = t.removeCallback;
	});

	afterEach(() => cleanup());

	describe("init", () => {
		it(
			"succeeds on an empty directory",
			async () => {
				await pushwork(["init", ...flags, workRoot]);
				expect(await listUserFiles(workRoot)).toEqual([]);
			},
			TEST_TIMEOUT,
		);

		it(
			"succeeds on a directory containing files",
			async () => {
				await fs.writeFile(path.join(workRoot, "a.txt"), "hello");
				await fs.writeFile(path.join(workRoot, "b.md"), "# B");
				await pushwork(["init", ...flags, workRoot]);
			},
			TEST_TIMEOUT,
		);

		it(
			"does not destroy or alter pre-existing user files",
			async () => {
				await fs.writeFile(path.join(workRoot, "keep.txt"), "do not touch");
				await fs.mkdir(path.join(workRoot, "subdir"));
				await fs.writeFile(
					path.join(workRoot, "subdir", "nested.txt"),
					"nested",
				);

				await pushwork(["init", ...flags, workRoot]);

				expect(await readText(path.join(workRoot, "keep.txt"))).toBe(
					"do not touch",
				);
				expect(
					await readText(path.join(workRoot, "subdir", "nested.txt")),
				).toBe("nested");
			},
			TEST_TIMEOUT,
		);
	});

	describe("url", () => {
		it(
			"prints an automerge: URL after init",
			async () => {
				await pushwork(["init", ...flags, workRoot]);
				const { stdout } = await pushwork(["url"], workRoot);
				expect(stdout.trim()).toMatch(/^automerge:[A-Za-z0-9]+/);
			},
			TEST_TIMEOUT,
		);

		it(
			"is stable across calls within one repo",
			async () => {
				await pushwork(["init", ...flags, workRoot]);
				const a = (await pushwork(["url"], workRoot)).stdout.trim();
				const b = (await pushwork(["url"], workRoot)).stdout.trim();
				expect(a).toBe(b);
			},
			TEST_TIMEOUT,
		);

		it(
			"differs between two independently initialized repos",
			async () => {
				const r1 = path.join(workRoot, "r1");
				const r2 = path.join(workRoot, "r2");
				await fs.mkdir(r1);
				await fs.mkdir(r2);
				await pushwork(["init", ...flags], r1);
				await pushwork(["init", ...flags], r2);
				const u1 = (await pushwork(["url"], r1)).stdout.trim();
				const u2 = (await pushwork(["url"], r2)).stdout.trim();
				expect(u1).not.toBe(u2);
			},
			TEST_TIMEOUT,
		);
	});

	describe("clone", () => {
		it(
			"reproduces a single text file",
			async () => {
				const a = path.join(workRoot, "a");
				const b = path.join(workRoot, "b");
				await fs.mkdir(a);

				await fs.writeFile(path.join(a, "hello.txt"), "Hello, World!");
				await pushwork(["init", ...flags], a);

				const url = (await pushwork(["url"], a)).stdout.trim();
				await pushwork(["clone", ...flags, url, b]);

				expect(await readText(path.join(b, "hello.txt"))).toBe("Hello, World!");
			},
			TEST_TIMEOUT,
		);

		it(
			"reproduces a nested directory tree",
			async () => {
				const a = path.join(workRoot, "a");
				const b = path.join(workRoot, "b");
				await fs.mkdir(a);
				await fs.mkdir(path.join(a, "src", "components"), {
					recursive: true,
				});
				await fs.writeFile(path.join(a, "package.json"), '{"name":"x"}');
				await fs.writeFile(path.join(a, "src", "index.ts"), "export {}");
				await fs.writeFile(
					path.join(a, "src", "components", "Button.tsx"),
					"export const Button = () => null",
				);

				await pushwork(["init", ...flags], a);
				const url = (await pushwork(["url"], a)).stdout.trim();
				await pushwork(["clone", ...flags, url, b]);

				expect(await readText(path.join(b, "package.json"))).toBe(
					'{"name":"x"}',
				);
				expect(await readText(path.join(b, "src", "index.ts"))).toBe(
					"export {}",
				);
				expect(
					await readText(path.join(b, "src", "components", "Button.tsx")),
				).toBe("export const Button = () => null");
			},
			TEST_TIMEOUT,
		);

		it(
			"reproduces binary file content byte-for-byte",
			async () => {
				const a = path.join(workRoot, "a");
				const b = path.join(workRoot, "b");
				await fs.mkdir(a);

				const bytes = Buffer.from([
					0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02,
					0xff, 0xfe, 0x10, 0x42,
				]);
				await fs.writeFile(path.join(a, "image.png"), bytes);

				await pushwork(["init", ...flags], a);
				const url = (await pushwork(["url"], a)).stdout.trim();
				await pushwork(["clone", ...flags, url, b]);

				const out = await fs.readFile(path.join(b, "image.png"));
				expect(out.equals(bytes)).toBe(true);
			},
			TEST_TIMEOUT,
		);

		it(
			"a fresh clone reports the same URL as the source",
			async () => {
				const a = path.join(workRoot, "a");
				const b = path.join(workRoot, "b");
				await fs.mkdir(a);
				await fs.writeFile(path.join(a, "x.txt"), "x");

				await pushwork(["init", ...flags], a);
				const urlA = (await pushwork(["url"], a)).stdout.trim();
				await pushwork(["clone", ...flags, urlA, b]);

				const urlB = (await pushwork(["url"], b)).stdout.trim();
				expect(urlB).toBe(urlA);
			},
			TEST_TIMEOUT,
		);
	});

	describe("sync — propagation between two repos", () => {
		async function setupPair() {
			const a = path.join(workRoot, "a");
			const b = path.join(workRoot, "b");
			await fs.mkdir(a);
			await pushwork(["init", ...flags], a);
			const url = (await pushwork(["url"], a)).stdout.trim();
			await pushwork(["clone", ...flags, url, b]);
			return { a, b };
		}

		it(
			"propagates a new file from A to B",
			async () => {
				const { a, b } = await setupPair();

				await fs.writeFile(path.join(a, "added.txt"), "new in A");
				await syncUntilConverged([a, b]);

				expect(await readText(path.join(b, "added.txt"))).toBe("new in A");
			},
			TEST_TIMEOUT,
		);

		it(
			"propagates a new file from B to A",
			async () => {
				const { a, b } = await setupPair();

				await fs.writeFile(path.join(b, "from-b.txt"), "new in B");
				await syncUntilConverged([a, b]);

				expect(await readText(path.join(a, "from-b.txt"))).toBe("new in B");
			},
			TEST_TIMEOUT,
		);

		it(
			"propagates a modification",
			async () => {
				const { a, b } = await setupPair();

				await fs.writeFile(path.join(a, "x.txt"), "v1");
				await syncUntilConverged([a, b]);
				expect(await readText(path.join(b, "x.txt"))).toBe("v1");

				await fs.writeFile(path.join(a, "x.txt"), "v2");
				await syncUntilConverged([a, b]);
				expect(await readText(path.join(b, "x.txt"))).toBe("v2");
			},
			TEST_TIMEOUT,
		);

		it(
			"propagates a deletion",
			async () => {
				const { a, b } = await setupPair();

				await fs.writeFile(path.join(a, "doomed.txt"), "doomed");
				await fs.writeFile(path.join(a, "kept.txt"), "kept");
				await syncUntilConverged([a, b]);
				expect(await pathExists(path.join(b, "doomed.txt"))).toBe(true);

				await fs.unlink(path.join(a, "doomed.txt"));
				await syncUntilConverged([a, b]);

				expect(await pathExists(path.join(b, "doomed.txt"))).toBe(false);
				expect(await readText(path.join(b, "kept.txt"))).toBe("kept");
			},
			TEST_TIMEOUT,
		);

		it(
			"propagates changes inside a nested directory",
			async () => {
				const { a, b } = await setupPair();

				await fs.mkdir(path.join(a, "deep", "deeper"), { recursive: true });
				await fs.writeFile(
					path.join(a, "deep", "deeper", "leaf.txt"),
					"leaf v1",
				);
				await syncUntilConverged([a, b]);

				expect(
					await readText(path.join(b, "deep", "deeper", "leaf.txt")),
				).toBe("leaf v1");

				await fs.writeFile(
					path.join(a, "deep", "deeper", "leaf.txt"),
					"leaf v2",
				);
				await syncUntilConverged([a, b]);

				expect(
					await readText(path.join(b, "deep", "deeper", "leaf.txt")),
				).toBe("leaf v2");
			},
			TEST_TIMEOUT,
		);

		it(
			"converges concurrent disjoint edits",
			async () => {
				const { a, b } = await setupPair();

				await fs.writeFile(path.join(a, "from-a.txt"), "A");
				await fs.writeFile(path.join(b, "from-b.txt"), "B");

				await syncUntilConverged([a, b]);

				expect(await readText(path.join(a, "from-a.txt"))).toBe("A");
				expect(await readText(path.join(a, "from-b.txt"))).toBe("B");
				expect(await readText(path.join(b, "from-a.txt"))).toBe("A");
				expect(await readText(path.join(b, "from-b.txt"))).toBe("B");
			},
			TEST_TIMEOUT,
		);

		it(
			"a third clone catches up to the current state",
			async () => {
				const { a, b } = await setupPair();

				await fs.writeFile(path.join(a, "shared.txt"), "shared content");
				await syncUntilConverged([a, b]);

				const c = path.join(workRoot, "c");
				const url = (await pushwork(["url"], a)).stdout.trim();
				await pushwork(["clone", ...flags, url, c]);

				expect(await readText(path.join(c, "shared.txt"))).toBe(
					"shared content",
				);
			},
			TEST_TIMEOUT,
		);
	});

	describe("default exclusions", () => {
		it(
			"does not sync .git or node_modules to a clone",
			async () => {
				const a = path.join(workRoot, "a");
				const b = path.join(workRoot, "b");
				await fs.mkdir(a);

				await fs.writeFile(path.join(a, "ok.txt"), "ok");

				await fs.mkdir(path.join(a, "node_modules"));
				await fs.writeFile(path.join(a, "node_modules", "lib.js"), "lib");

				await fs.mkdir(path.join(a, ".git"));
				await fs.writeFile(path.join(a, ".git", "HEAD"), "ref");

				await pushwork(["init", ...flags], a);
				const url = (await pushwork(["url"], a)).stdout.trim();
				await pushwork(["clone", ...flags, url, b]);

				expect(await pathExists(path.join(b, "ok.txt"))).toBe(true);
				expect(await pathExists(path.join(b, "node_modules"))).toBe(false);
				expect(await pathExists(path.join(b, ".git"))).toBe(false);
			},
			TEST_TIMEOUT,
		);
	});

	describe("end-to-end session", () => {
		it(
			"supports a realistic two-user collaboration session",
			async () => {
				// Alice initializes a project with several files.
				const alice = path.join(workRoot, "alice");
				await fs.mkdir(alice);
				await fs.writeFile(path.join(alice, "README"), "# Project");
				await fs.mkdir(path.join(alice, "src"));
				await fs.writeFile(path.join(alice, "src", "main.ts"), "// v1");
				await pushwork(["init", ...flags], alice);

				// Bob clones Alice's project.
				const bob = path.join(workRoot, "bob");
				const url = (await pushwork(["url"], alice)).stdout.trim();
				await pushwork(["clone", ...flags, url, bob]);

				expect(await readText(path.join(bob, "README"))).toBe("# Project");
				expect(await readText(path.join(bob, "src", "main.ts"))).toBe("// v1");

				// Bob edits a file and adds a new one. Alice edits a different file.
				await fs.writeFile(path.join(bob, "src", "main.ts"), "// v2 (bob)");
				await fs.writeFile(
					path.join(bob, "src", "util.ts"),
					"export const x = 1",
				);
				await fs.writeFile(path.join(alice, "README"), "# Project\n\nNotes");

				await syncUntilConverged([alice, bob]);

				// Both should see all changes.
				expect(await readText(path.join(alice, "src", "main.ts"))).toBe(
					"// v2 (bob)",
				);
				expect(await readText(path.join(alice, "src", "util.ts"))).toBe(
					"export const x = 1",
				);
				expect(await readText(path.join(bob, "README"))).toBe(
					"# Project\n\nNotes",
				);

				// Bob deletes the util file.
				await fs.unlink(path.join(bob, "src", "util.ts"));
				await syncUntilConverged([alice, bob]);

				expect(await pathExists(path.join(alice, "src", "util.ts"))).toBe(
					false,
				);
				expect(await pathExists(path.join(bob, "src", "util.ts"))).toBe(false);

				// Final state must be byte-for-byte identical.
				expect(await hashUserContent(alice)).toBe(
					await hashUserContent(bob),
				);
			},
			TEST_TIMEOUT * 2,
		);
	});
});
