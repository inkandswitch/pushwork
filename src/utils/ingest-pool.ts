/**
 * Worker pools for the shared-nothing parallel-ingest experiment
 * (PUSHWORK_PARALLEL_INGEST=2 / "shard"): workers own full Repos (own
 * Wasm, own storage writes, own socket) and report only {relPath, url,
 * heads}; the main thread never materializes the docs.
 *
 * Worker scripts run as compiled CommonJS, so a build (`npm run build`)
 * must exist even when the engine itself runs from src via tsx.
 *
 * (A second variant — "import" mode, workers shipping doc bytes for the
 * main thread to repo.import — was measured wall-neutral and deleted
 * 2026-06-12; see .ignore/PARALLEL_INGEST_EXPERIMENT.md.)
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {Worker} from "node:worker_threads"
import type {
	ShardWorkerData,
	ShardWorkerReport,
} from "../workers/shard-ingest-worker"
import type {DirectoryConfig, SyncProtocol} from "../types"

export interface IngestTask {
	relPath: string
	content: string | Uint8Array
	isArtifact: boolean
}

export type ParallelIngestMode = "shard" | null

/**
 * PUSHWORK_PARALLEL_INGEST=2 (or "shard") enables shared-nothing shard
 * ingest. ("1"/"import" was the refuted repo.import variant, removed.)
 */
export function parallelIngestMode(): ParallelIngestMode {
	switch (process.env.PUSHWORK_PARALLEL_INGEST) {
		case "2":
		case "shard":
			return "shard"
		default:
			return null
	}
}

export function ingestWorkerCount(): number {
	const fromEnv = Number(process.env.PUSHWORK_WORKERS)
	if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
	return Math.max(1, (os.cpus()?.length ?? 4) - 1)
}

// ─── Shared-nothing shard pool (mode "shard") ─────────────────────────

export type ShardFileOutcome =
	| {relPath: string; ok: true; url: string; heads: string[]}
	| {relPath: string; ok: false; error: string}

export interface ShardRunOutcome {
	results: ShardFileOutcome[]
	/** Paths whose docs were created but did not converge to the server. */
	unsynced: string[]
	/** relPaths of shards whose worker crashed (fall back on main thread). */
	failedPaths: string[]
}

function resolveShardWorkerScript(): string {
	const candidates = [
		path.join(__dirname, "..", "workers", "shard-ingest-worker.js"),
		path.join(__dirname, "..", "..", "dist", "workers", "shard-ingest-worker.js"),
	]
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate
	}
	throw new Error(
		`parallel ingest: compiled shard worker not found (tried ${candidates.join(", ")}). Run \`npm run build\` first.`
	)
}

/**
 * Run shared-nothing shard ingest: split `tasks` round-robin across
 * `workerCount` workers, each of which builds + persists + uploads its
 * shard with its own Repo, reporting `{relPath, url, heads}` per file.
 *
 * A crashed worker fails only its own shard (paths returned in
 * `failedPaths` so the caller can fall back to main-thread creation).
 */
export async function runShardIngest(
	workingDir: string,
	config: DirectoryConfig,
	protocol: SyncProtocol,
	tasks: IngestTask[],
	workerCount = ingestWorkerCount(),
	// Test seam: inject a stub worker script (e.g. one that exits without
	// reporting) to exercise the pool's failure paths without Wasm.
	workerScript?: string
): Promise<ShardRunOutcome> {
	const script = workerScript ?? resolveShardWorkerScript()
	const count = Math.min(workerCount, tasks.length)

	// Round-robin so size skew spreads across shards.
	const shards: IngestTask[][] = Array.from({length: count}, () => [])
	tasks.forEach((task, i) => shards[i % count].push(task))

	const outcome: ShardRunOutcome = {results: [], unsynced: [], failedPaths: []}

	await Promise.all(
		shards.map(shard => {
			const workerData: ShardWorkerData = {
				workingDir,
				config,
				protocol,
				tasks: shard,
			}
			return new Promise<void>(resolve => {
				const worker = new Worker(script, {workerData})
				let reported = false

				worker.on("message", (report: ShardWorkerReport) => {
					reported = true
					outcome.results.push(...(report.results as ShardFileOutcome[]))
					outcome.unsynced.push(...report.unsynced)
					// The report is sent only after the worker's repo.shutdown()
					// has flushed storage, so nothing of value remains in the
					// thread. Terminate eagerly: online, a leftover Subduction
					// sync timer (60s) otherwise keeps the thread's event loop
					// alive long after shutdown, stalling the whole pool.
					void worker.terminate()
				})

				let failed = false
				const fail = () => {
					if (!reported && !failed) {
						failed = true
						outcome.failedPaths.push(...shard.map(t => t.relPath))
					}
				}

				worker.on("error", () => {
					fail()
					resolve()
				})
				worker.on("exit", () => {
					// Exit-before-report is a failure regardless of exit code: a
					// worker that process.exit(0)s without posting still lost its
					// shard. (fail() is a no-op once the report has arrived, which
					// covers the eager-terminate exit after a successful report.)
					fail()
					resolve()
				})
			})
		})
	)

	return outcome
}

// ─── Shared-nothing clone-pull pool (mode "shard") ────────────────────

export interface ClonePullTask {
	relPath: string
	url: string
}

export type ClonePullOutcome =
	| {
			relPath: string
			ok: true
			url: string
			heads: string[]
			isText: boolean
			contentHash: string
	  }
	| {relPath: string; ok: false; error: string}

export interface ClonePullRunOutcome {
	results: ClonePullOutcome[]
	/** relPaths of shards whose worker crashed (fall back on main thread). */
	failedPaths: string[]
}

function resolveCloneWorkerScript(): string {
	const candidates = [
		path.join(__dirname, "..", "workers", "shard-clone-worker.js"),
		path.join(__dirname, "..", "..", "dist", "workers", "shard-clone-worker.js"),
	]
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate
	}
	throw new Error(
		`parallel clone: compiled shard worker not found (tried ${candidates.join(", ")}). Run \`npm run build\` first.`
	)
}

/**
 * Run shared-nothing shard pull: split remote file entries round-robin
 * across workers, each of which downloads/loads + materializes its
 * shard with its own Repo, writes the local files itself, and reports
 * `{relPath, url, heads, contentHash}`.
 */
export async function runShardPull(
	workingDir: string,
	config: DirectoryConfig,
	protocol: SyncProtocol,
	tasks: ClonePullTask[],
	workerCount = ingestWorkerCount()
): Promise<ClonePullRunOutcome> {
	const script = resolveCloneWorkerScript()
	const count = Math.min(workerCount, tasks.length)

	const shards: ClonePullTask[][] = Array.from({length: count}, () => [])
	tasks.forEach((task, i) => shards[i % count].push(task))

	const outcome: ClonePullRunOutcome = {results: [], failedPaths: []}

	await Promise.all(
		shards.map(shard => {
			const workerData = {workingDir, config, protocol, tasks: shard}
			return new Promise<void>(resolve => {
				const worker = new Worker(script, {workerData})
				let reported = false
				let failed = false

				worker.on("message", (report: {results: ClonePullOutcome[]}) => {
					reported = true
					outcome.results.push(...report.results)
					// Report arrives only after the worker's repo.shutdown();
					// terminate eagerly (see runShardIngest for rationale).
					void worker.terminate()
				})

				const fail = () => {
					if (!reported && !failed) {
						failed = true
						outcome.failedPaths.push(...shard.map(t => t.relPath))
					}
				}

				worker.on("error", () => {
					fail()
					resolve()
				})
				worker.on("exit", () => {
					// Exit-before-report is a failure regardless of exit code: a
					// worker that process.exit(0)s without posting still lost its
					// shard. (fail() is a no-op once the report has arrived, which
					// covers the eager-terminate exit after a successful report.)
					fail()
					resolve()
				})
			})
		})
	)

	return outcome
}
