/**
 * Worker-pool failure paths (src/utils/ingest-pool.ts, "import" mode).
 *
 * Regression guard: a worker that exits without an `error` event (e.g.
 * `process.exit` inside the worker, external terminate) used to leave its
 * in-flight task unsettled — `settled < tasks.length` stayed true and the
 * async generator awaited its wake promise forever, hanging the sync.
 * The pool must instead fail the task and (if the pool is exhausted) the
 * unclaimed tail. Uses a stub worker script via the `workerScript` test seam
 * so no Wasm or compiled dist is involved.
 */

import * as path from "path";
import { runIngestPool, IngestTask, IngestResult } from "../../src/utils/ingest-pool";

const EXIT_STUB = path.join(__dirname, "../fixtures/exit-without-report-worker.js");

function task(relPath: string): IngestTask {
	return { relPath, content: "x", isArtifact: false };
}

async function collect(
	tasks: IngestTask[],
	workers: number
): Promise<IngestResult[]> {
	const out: IngestResult[] = [];
	for await (const r of runIngestPool(tasks, workers, EXIT_STUB)) {
		out.push(r);
	}
	return out;
}

describe("runIngestPool worker-exit handling", () => {
	it("a worker exiting without reporting fails its task instead of hanging", async () => {
		const results = await collect([task("a.txt")], 1);

		expect(results).toHaveLength(1);
		expect(results[0].relPath).toBe("a.txt");
		expect(results[0].ok).toBe(false);
		if (!results[0].ok) {
			expect(results[0].error).toMatch(/exited with code 0/);
		}
	}, 15000);

	it("pool exhaustion fails the unclaimed tail (every task settles)", async () => {
		// 1 worker, 3 tasks: the worker dies on task 1; tasks 2-3 are unclaimed
		// and must be failed rather than left pending.
		const tasks = [task("a.txt"), task("b.txt"), task("c.txt")];
		const results = await collect(tasks, 1);

		expect(results).toHaveLength(3);
		expect(results.map((r) => r.relPath).sort()).toEqual([
			"a.txt",
			"b.txt",
			"c.txt",
		]);
		expect(results.every((r) => !r.ok)).toBe(true);
	}, 15000);

	it("yields nothing for an empty task list", async () => {
		const results = await collect([], 1);
		expect(results).toHaveLength(0);
	});
});
