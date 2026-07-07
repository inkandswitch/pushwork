/**
 * Resilience guard: with an unreachable sync server, `pushwork init` must finish
 * promptly (not hang on teardown), report an honest not-synced verdict, and keep
 * the sync layer's connection logs out of the CLI output.
 *
 * Log suppression must live in openRepo (not only the CLI) so it covers every
 * Repo construction path. Network-free: the endpoint is a closed localhost
 * port (immediate ECONNREFUSED).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);
const CLI = path.join(__dirname, "..", "..", "dist", "cli.js");

// A closed port on loopback → immediate ECONNREFUSED, no DNS, no real network.
const DEAD_SERVER = "ws://127.0.0.1:1";

tmp.setGracefulCleanup();

describe("unreachable sync server", () => {
	it(
		"init against a dead server finishes promptly, reports offline, and stays quiet",
		async () => {
			const dir = tmp.dirSync({ unsafeCleanup: true }).name;
			await Promise.all(
				Array.from({ length: 40 }, (_, i) =>
					fs.writeFile(path.join(dir, `file_${i}.txt`), `content ${i}\n`),
				),
			);

			const start = Date.now();
			const { stdout, stderr } = await execFileP(
				"node",
				[CLI, "--porcelain", "init", dir],
				{
					cwd: dir,
					env: {
						...process.env,
						PUSHWORK_SUBDUCTION_SERVER: DEAD_SERVER,
						FORCE_COLOR: "0",
						NO_COLOR: "1",
					},
					timeout: 50_000,
					maxBuffer: 16 * 1024 * 1024,
				},
			);
			const elapsed = Date.now() - start;
			const output = stdout + stderr;

			// (a) didn't hang
			expect(elapsed).toBeLessThan(45_000);
			expect(stdout).toContain("INITIALIZED");
			// (b) honest verdict: offline, not a false synced
			expect(stdout).toContain("sync\toffline");
			expect(stdout).not.toContain("sync\tsynced");
			// (c) no connection-log spam (main or workers), no unhandled fault
			expect(output).not.toContain("[automerge-repo:subduction");
			expect(stderr).not.toMatch(/UnhandledPromiseRejection|Uncaught|unhandledRejection/);
		},
		50_000,
	);
});
