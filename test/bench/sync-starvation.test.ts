import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Deterministic event-loop starvation repro.
 *
 * Ingesting a few thousand files makes `pushwork sync` block the Node
 * event loop for *seconds* in one unbroken stretch — thousands of small
 * synchronous Automerge Wasm calls (doc creation, content splice,
 * directory mutation) run back-to-back with only microtask awaits
 * between them, so the macrotask queue (timers AND Subduction's
 * socket/pong) is never serviced. That starvation is what trips the
 * sync server's keepalive and produces the `request timed out` symptom.
 *
 * This drives the offline bench (`bench/sync-bench.ts`) in a subprocess
 * — both because it sidesteps the Wasm/ESM-in-Jest wall and because it
 * measures a real process's event-loop drift.
 *
 * It is a **regression guard** for the macrotask-yield fix
 * (`pushLocalChanges` calls `makeYielder()`): with the yield it passes
 * (longest block ~0.6 s); remove the yield and it fails (~4 s blocks,
 * which is what trips the sync server's keepalive). Measured separation
 * on the dev box: fixed ≈ 600–670 ms, broken ≈ 3500–4600 ms.
 *
 * Note on metrics: we assert `maxDriftMs` (the longest *single* block —
 * the thing that misses pongs), NOT `blockedFraction`. The fraction stays
 * high (~55–85%) even when fixed because the ingest is genuinely
 * CPU-bound; yielding breaks the work into <50 ms chunks rather than
 * reducing it. A residual ~0.6 s block remains inside SubductionSource's
 * own save path (a separate, Subduction-side follow-up).
 *
 * Gated behind PUSHWORK_BENCH=1 so normal CI stays green and fast:
 *   PUSHWORK_BENCH=1 npx jest test/bench/sync-starvation
 *   PUSHWORK_YIELD_MS=0 PUSHWORK_BENCH=1 npx jest ...   # see it fail
 */
const gated = process.env.PUSHWORK_BENCH ? it : it.skip;

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BENCH = path.join(REPO_ROOT, "bench", "sync-bench.ts");

const FILES = 1500;
// Fixed runs land ~600-670ms; broken (no yield) ~3500-4600ms. 1500ms
// cleanly separates them with margin for a noisy box.
const MAX_BLOCK_MS = 1500;

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
    "npx",
    [
      "tsx",
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
    { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }
  );
  const lastLine = stdout.trim().split("\n").pop() ?? "{}";
  return JSON.parse(lastLine) as BenchSummary;
}

describe("sync event-loop starvation", () => {
  gated(
    `ingesting ${FILES} files must not block the event loop > ${MAX_BLOCK_MS}ms`,
    async () => {
      const summary = await runBench(FILES);

      // Sanity: the ingest actually happened.
      expect(summary.errors).toBe(0);
      expect(summary.filesChanged).toBe(FILES);
      expect(summary.drift).not.toBeNull();

      // The push loop must yield often enough that no single synchronous
      // stretch starves the loop (and thus the Subduction socket/pong).
      expect(summary.drift!.maxDriftMs).toBeLessThan(MAX_BLOCK_MS);
    },
    120_000
  );
});
