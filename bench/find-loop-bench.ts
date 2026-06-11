/**
 * Deterministic microbench for the macrotask-`whenReady` change.
 *
 * Creates N documents in an offline repo (so they're all resident), then
 * runs the exact pattern `whenReady` targets: a tight
 * `for (...) await repo.find(cachedUrl)` loop. Without the macrotask yield
 * the loop is microtask-only and blocks the event loop for the whole run;
 * with it, the loop yields ~every 50ms and the drift collapses.
 *
 *   npx tsx bench/find-loop-bench.ts 3000                      # yield on
 *   AUTOMERGE_REPO_FIND_YIELD=0 npx tsx bench/find-loop-bench.ts 3000   # off
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";

import { ConfigManager } from "../src/core/config";
import { createRepo } from "../src/utils/repo-factory";
import {
  getProfileReport,
  resetProfile,
  setProfilingEnabled,
  startDriftProbe,
  stopDriftProbe,
} from "../src/utils/profile";

async function main(): Promise<void> {
  const N = parseInt(process.argv[2] ?? "3000", 10);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "findloop-"));
  try {
    await fs.mkdir(path.join(root, ".pushwork", "automerge"), {
      recursive: true,
    });
    const config = new ConfigManager(root).getDefaultDirectoryConfig();
    config.sync_enabled = false; // offline ⇒ all docs resident, no network
    const repo = await createRepo(root, config, "subduction");

    const urls: string[] = [];
    for (let i = 0; i < N; i++) {
      const h = repo.create({ n: i, data: "x".repeat(200) });
      urls.push(h.url);
    }
    // Let attach/save settle so finds hit the "ready" fast path.
    await new Promise(r => setTimeout(r, 300));

    setProfilingEnabled(true);
    resetProfile();
    startDriftProbe();
    const t0 = performance.now();
    for (const url of urls) {
      await repo.find(url); // cached ⇒ whenReady "already ready" path
    }
    const loopMs = Math.round(performance.now() - t0);

    const sd0 = performance.now();
    await repo.shutdown();
    const shutdownMs = Math.round(performance.now() - sd0);
    stopDriftProbe();

    const r = getProfileReport();
    process.stdout.write(
      JSON.stringify({
        N,
        loopMs,
        shutdownMs,
        totalMs: loopMs + shutdownMs,
        yieldDisabled: process.env.AUTOMERGE_REPO_FIND_YIELD === "0",
        maxDriftMs: r.drift?.maxDriftMs,
        blockedPct: r.drift ? Math.round(r.drift.blockedFraction * 100) : null,
        timerSamples: r.drift?.samples,
      }) + "\n"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
