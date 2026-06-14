/**
 * Shard-pool failure paths (src/utils/ingest-pool.ts).
 *
 * Regression guard for the worker-death class of bug: a worker that exits
 * without posting its report (process.exit inside the worker, external
 * terminate, OOM-kill) must fail its shard's tasks — via `failedPaths` so
 * the engine falls back to main-thread creation — rather than leaving the
 * pool's promise pending forever. Uses a stub worker script via the
 * `workerScript` test seam so no Wasm or compiled dist is involved.
 */

import * as path from "path";
import {
	ingestWorkerCount,
	parallelIngestMode,
	shouldAutoShard,
	shouldDeferRemoteContent,
	runShardIngest,
	AUTO_SHARD_THRESHOLD,
	SHARD_WORKER_CAP,
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
			undefined,
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
			undefined,
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

	it("caps the auto default at SHARD_WORKER_CAP (EMFILE guard)", () => {
		delete process.env.PUSHWORK_WORKERS;
		expect(ingestWorkerCount()).toBeLessThanOrEqual(SHARD_WORKER_CAP);
	});

	it("PUSHWORK_WORKERS can exceed the cap (explicit override)", () => {
		process.env.PUSHWORK_WORKERS = String(SHARD_WORKER_CAP + 8);
		expect(ingestWorkerCount()).toBe(SHARD_WORKER_CAP + 8);
	});
});

describe("auto-shard policy", () => {
	const saved = process.env.PUSHWORK_PARALLEL_INGEST;
	afterEach(() => {
		if (saved === undefined) delete process.env.PUSHWORK_PARALLEL_INGEST;
		else process.env.PUSHWORK_PARALLEL_INGEST = saved;
	});

	it("auto-enables shard past the threshold, declines below it", () => {
		delete process.env.PUSHWORK_PARALLEL_INGEST;
		expect(shouldAutoShard(AUTO_SHARD_THRESHOLD - 1)).toBe(false);
		expect(shouldAutoShard(AUTO_SHARD_THRESHOLD)).toBe(true);
	});

	it("explicit =2 forces shard even below the threshold", () => {
		process.env.PUSHWORK_PARALLEL_INGEST = "2";
		expect(shouldAutoShard(1)).toBe(true);
	});

	it("explicit 0/off declines even above the threshold", () => {
		process.env.PUSHWORK_PARALLEL_INGEST = "0";
		expect(shouldAutoShard(10_000)).toBe(false);
		process.env.PUSHWORK_PARALLEL_INGEST = "off";
		expect(shouldAutoShard(10_000)).toBe(false);
	});

	it("defers remote content for both clone and incremental (ADR-025)", () => {
		// New clean remote files are deferred so the pull phase can auto-shard
		// a big incremental pull, not just a clone. The pull falls back to the
		// main thread below AUTO_SHARD_THRESHOLD, so deferring is always safe.
		delete process.env.PUSHWORK_PARALLEL_INGEST;
		expect(shouldDeferRemoteContent(0)).toBe(true); // clone
		expect(shouldDeferRemoteContent(500)).toBe(true); // incremental sync
	});

	it("forced off never defers (the inline-materialization escape hatch)", () => {
		process.env.PUSHWORK_PARALLEL_INGEST = "0";
		expect(shouldDeferRemoteContent(0)).toBe(false);
		expect(shouldDeferRemoteContent(500)).toBe(false);
		process.env.PUSHWORK_PARALLEL_INGEST = "off";
		expect(shouldDeferRemoteContent(500)).toBe(false);
	});
});
