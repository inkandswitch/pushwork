import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Event-loop starvation guard for the ingest path.
 *
 * Ingesting a few thousand files makes `pushwork init`/`sync` run thousands
 * of small synchronous Automerge Wasm calls (doc creation, content splice,
 * directory mutation) back-to-back with only microtask awaits between them.
 * Without a macrotask yield, the loop is blocked in one unbroken stretch and
 * the macrotask queue (timers AND the sync server's socket/pong) is never
 * serviced — that starvation is what trips a sync server's keepalive and
 * surfaces as `request timed out`.
 *
 * This drives the offline bench (`bench/sync-bench.ts`) in a subprocess —
 * both to sidestep the Wasm/ESM dual-load that breaks under in-process
 * transpilers and to measure a real process's event-loop drift. The bench is
 * compiled to CommonJS (matching the shipped CLI) so the Subduction Wasm
 * loads as a single consistent instance under Node's `require(ESM)`.
 *
 * We assert `maxDriftMs` (the longest *single* block — the thing that misses
 * pongs), NOT `blockedFraction`: ingest is genuinely CPU-bound, so the
 * fraction stays high regardless; the question is only whether any one
 * synchronous stretch runs long enough to trip a sync server's keepalive.
 *
 * Gated behind PUSHWORK_BENCH=1 so normal CI stays fast:
 *   PUSHWORK_BENCH=1 npx vitest run test/bench/sync-starvation
 */
const gated = process.env.PUSHWORK_BENCH ? it : it.skip;

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BENCH_TSCONFIG = path.join(REPO_ROOT, "bench", "tsconfig.json");
const BENCH = path.join(REPO_ROOT, "dist-bench", "bench", "sync-bench.js");

const FILES = 1500;
// This branch's per-file async ingest breaks the work into several blocks
// (longest ~1.5-1.8s at 1500 files), so the threshold guards against a
// regression to one fully-synchronous multi-second stretch — what actually
// starves a keepalive — with margin for a noisy box. See .ignore/BENCH-NOTES.md.
const MAX_BLOCK_MS = 3000;

interface BenchSummary {
	filesChanged: number;
	errors: number;
	drift: {
		maxDriftMs: number;
		blockedFraction: number;
		events: number;
	} | null;
}

async function runBench(files: number): Promise<BenchSummary> {
	const { stdout } = await execFileAsync(
		"node",
		[
			BENCH,
			"--files",
			String(files),
			"--size",
			"512",
			"--text",
			"1",
			"--fanout",
			"20",
		],
		{
			cwd: REPO_ROOT,
			maxBuffer: 64 * 1024 * 1024,
			// This guard measures the MAIN-THREAD ingest path (macrotask yields).
			// Ingest now shards by count, so force it off to exercise that path.
			env: { ...process.env, PUSHWORK_PARALLEL_INGEST: "off" },
		},
	);
	const lastLine = stdout.trim().split("\n").pop() ?? "{}";
	return JSON.parse(lastLine) as BenchSummary;
}

describe("sync event-loop starvation", () => {
	// Compile the bench to CJS once before the (gated) run. Skipped work when
	// the bench gate is off, so normal CI never pays the build cost.
	beforeAll(async () => {
		if (!process.env.PUSHWORK_BENCH) return;
		await execFileAsync("npx", ["tsc", "-p", BENCH_TSCONFIG], {
			cwd: REPO_ROOT,
		});
	}, 120_000);

	gated(
		`ingesting ${FILES} files must not block the event loop > ${MAX_BLOCK_MS}ms`,
		async () => {
			const summary = await runBench(FILES);

			// Sanity: the ingest actually happened.
			expect(summary.errors).toBe(0);
			expect(summary.filesChanged).toBe(FILES);
			expect(summary.drift).not.toBeNull();

			// No single synchronous stretch may starve the loop (and thus the
			// sync server socket/pong).
			expect(summary.drift!.maxDriftMs).toBeLessThan(MAX_BLOCK_MS);
		},
		120_000,
	);
});
