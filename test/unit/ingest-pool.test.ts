/**
 * Shard-pool failure paths (src/utils/ingest-pool.ts).
 *
 * Regression guard for the worker-death class of bug: a worker that exits
 * without posting its report (process.exit inside the worker, external
 * terminate, OOM-kill) must fail its shard's tasks — via `failedPaths` so
 * the engine falls back to main-thread creation — rather than leaving the
 * pool's promise pending forever. Uses a stub worker script via the
 * `workerScript` test seam so no Wasm or compiled dist is involved.
 *
 * (The "import"-mode pool this suite originally targeted was a refuted
 * experiment, deleted 2026-06-12; the shard pools share the same
 * exit-handling pattern, fixed in the same commit.)
 */

import * as path from "path";
import {
	ingestWorkerCount,
	parallelIngestMode,
	runShardIngest,
	IngestTask,
} from "../../src/utils/ingest-pool";
import { ConfigManager } from "../../src/core/config";

const EXIT_STUB = path.join(__dirname, "../fixtures/exit-without-report-worker.js");

function task(relPath: string): IngestTask {
	return { relPath, content: "x", isArtifact: false };
}

const config = new ConfigManager("/tmp").getDefaultDirectoryConfig();

describe("runShardIngest worker-exit handling", () => {
	it("a worker exiting without reporting fails its shard instead of hanging", async () => {
		const outcome = await runShardIngest(
			"/tmp",
			config,
			"subduction",
			[task("a.txt")],
			1,
			EXIT_STUB
		);

		expect(outcome.results).toHaveLength(0);
		expect(outcome.failedPaths).toEqual(["a.txt"]);
	}, 15000);

	it("every task in a dead worker's shard lands in failedPaths", async () => {
		// 2 workers, 4 tasks round-robined: both workers die; all 4 tasks
		// must be reported failed (none silently dropped or left pending).
		const tasks = [task("a.txt"), task("b.txt"), task("c.txt"), task("d.txt")];
		const outcome = await runShardIngest(
			"/tmp",
			config,
			"subduction",
			tasks,
			2,
			EXIT_STUB
		);

		expect(outcome.results).toHaveLength(0);
		expect(outcome.failedPaths.sort()).toEqual([
			"a.txt",
			"b.txt",
			"c.txt",
			"d.txt",
		]);
	}, 15000);
});

describe("parallelIngestMode", () => {
	const saved = process.env.PUSHWORK_PARALLEL_INGEST;
	afterEach(() => {
		if (saved === undefined) delete process.env.PUSHWORK_PARALLEL_INGEST;
		else process.env.PUSHWORK_PARALLEL_INGEST = saved;
	});

	it("recognizes shard mode and rejects the removed import mode", () => {
		process.env.PUSHWORK_PARALLEL_INGEST = "2";
		expect(parallelIngestMode()).toBe("shard");
		process.env.PUSHWORK_PARALLEL_INGEST = "shard";
		expect(parallelIngestMode()).toBe("shard");
		// "1" selected the refuted import variant — now plain serial.
		process.env.PUSHWORK_PARALLEL_INGEST = "1";
		expect(parallelIngestMode()).toBeNull();
		delete process.env.PUSHWORK_PARALLEL_INGEST;
		expect(parallelIngestMode()).toBeNull();
	});
});

describe("ingestWorkerCount", () => {
	const saved = process.env.PUSHWORK_WORKERS;
	afterEach(() => {
		if (saved === undefined) delete process.env.PUSHWORK_WORKERS;
		else process.env.PUSHWORK_WORKERS = saved;
	});

	it("honors PUSHWORK_WORKERS and floors to at least 1", () => {
		process.env.PUSHWORK_WORKERS = "3";
		expect(ingestWorkerCount()).toBe(3);
		process.env.PUSHWORK_WORKERS = "0"; // invalid → cores-based default ≥ 1
		expect(ingestWorkerCount()).toBeGreaterThanOrEqual(1);
	});
});
