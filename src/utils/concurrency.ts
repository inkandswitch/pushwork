/**
 * Concurrency primitives for keeping the event loop responsive during
 * large syncs.
 *
 * The sync engine does thousands of small *synchronous* Automerge/Wasm
 * calls (doc creation, content splice, directory mutation). Even though
 * the surrounding code is `async`, the `await`s between those calls
 * resolve as microtasks (already-settled promises / cached `repo.find`),
 * so Node never advances to the macrotask phases — timers AND the
 * WebSocket socket where Subduction reads sync messages and flushes
 * pongs. The loop monopolizes the thread for seconds, the server misses
 * pongs, and the connection is reaped (`request timed out`).
 *
 * `yieldToEventLoop()` forces a real macrotask boundary via
 * `setImmediate` (the `check` phase, right after `poll`), so the socket
 * gets serviced. A time-budgeted `makeYielder()` calls it periodically,
 * restoring liveness at negligible throughput cost.
 */

import * as os from "os";

/**
 * Yield to the macrotask queue so libuv can run the `poll` phase (socket
 * I/O, fs completions) and `timers`. `setImmediate` fires in the `check`
 * phase, immediately after `poll`, making it the right primitive for
 * "let I/O breathe, then resume".
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Concurrency budget for I/O-bound fan-out (file reads, stats, remote
 * `repo.find` round-trips). Scaled to cores — enough to keep the storage
 * device's queue and the sync socket fed, bounded so a 50k-file tree
 * doesn't open 50k descriptors or buffer 50k file contents at once.
 * Override with PUSHWORK_IO_CONCURRENCY (used for
 * A/B measurement of the clone/pull download).
 */
export const IO_CONCURRENCY = (() => {
  const fromEnv = Number(process.env.PUSHWORK_IO_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return Math.max(8, (os.cpus()?.length ?? 4) * 4);
})();

/**
 * Default time budget between yields, in milliseconds. The loop runs
 * synchronously for at most ~this long before handing the event loop a
 * turn. 50 ms comfortably beats the sync server's ~100 ms keepalive
 * cadence while keeping the number of yielded loop-turns small.
 */
export const YIELD_BUDGET_MS = (() => {
  // Guard against a non-numeric PUSHWORK_YIELD_MS: an unguarded NaN slips
  // past makeYielder's `<= 0` no-op check yet makes `elapsed >= NaN` always
  // false, silently disabling yielding (and the Subduction-timeout
  // protection it provides). `0` is honored (disables yielding for A/B).
  const v = Number(process.env.PUSHWORK_YIELD_MS);
  return Number.isFinite(v) ? v : 50;
})();

/**
 * Make a time-budgeted yielder. Call the returned function frequently
 * (e.g. once per item) in a hot loop; it only actually yields once more
 * than `budgetMs` has elapsed since the last yield, so the cost is
 * independent of per-item work size. Count-based cadences tune badly
 * when item cost varies (a file's Automerge work ranges from microseconds
 * to tens of milliseconds); a time budget bounds the worst-case block
 * directly.
 */
export function makeYielder(
  budgetMs: number = YIELD_BUDGET_MS
): () => Promise<void> {
  // budgetMs <= 0 disables yielding (no-op) — used for A/B measurement.
  if (budgetMs <= 0) {
    return async () => {};
  }
  let last = performance.now();
  return async () => {
    if (performance.now() - last >= budgetMs) {
      await yieldToEventLoop();
      last = performance.now();
    }
  };
}

/**
 * Map over `items` running at most `limit` calls to `fn` concurrently.
 * Order-preserving (like `p-map`). A bounded pool instead of an
 * unbounded `Promise.all` so a 50k-file tree doesn't schedule 50k
 * in-flight `repo.find`/read operations at once.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: workers }, run));
  return results;
}
