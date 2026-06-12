/**
 * A small worker_threads pool for the parallel-ingest experiment.
 *
 * Runs `file-doc-worker` tasks (build an Automerge file document, return its
 * serialized bytes) across `PUSHWORK_WORKERS` threads (default cores - 1) and
 * yields results as they complete, so the caller can `repo.import` each doc
 * on the main thread while workers keep building the rest.
 *
 * Enabled via PUSHWORK_PARALLEL_INGEST=1. The worker script runs as compiled
 * CommonJS, so a build (`npm run build`) must exist even when the engine
 * itself runs from src via tsx (e.g. the bench).
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {Worker} from "node:worker_threads"
import type {
	BuildFileDocRequest,
	BuildFileDocResponse,
} from "../workers/file-doc-worker"
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

export type IngestResult =
	| {relPath: string; ok: true; bytes: Uint8Array}
	| {relPath: string; ok: false; error: string}

export type ParallelIngestMode = "import" | "shard" | null

/**
 * PUSHWORK_PARALLEL_INGEST selects the experiment variant:
 *   "1" / "import" — workers build docs, main thread repo.imports them
 *                    (measured wall-neutral: A.load ≈ A.from+splice)
 *   "2" / "shard"  — shared-nothing: workers own full repos (own Wasm,
 *                    own storage writes, own socket), main thread only
 *                    stitches reported URLs into directories
 */
export function parallelIngestMode(): ParallelIngestMode {
	switch (process.env.PUSHWORK_PARALLEL_INGEST) {
		case "1":
		case "import":
			return "import"
		case "2":
		case "shard":
			return "shard"
		default:
			return null
	}
}

export function parallelIngestEnabled(): boolean {
	return parallelIngestMode() === "import"
}

export function ingestWorkerCount(): number {
	const fromEnv = Number(process.env.PUSHWORK_WORKERS)
	if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
	return Math.max(1, (os.cpus()?.length ?? 4) - 1)
}

/**
 * Locate the compiled worker script. When pushwork itself runs from dist
 * the worker sits next to it; when running from src (tsx) we fall back to
 * the dist build at the package root.
 */
export function resolveWorkerScript(): string {
	const candidates = [
		path.join(__dirname, "..", "workers", "file-doc-worker.js"),
		path.join(__dirname, "..", "..", "dist", "workers", "file-doc-worker.js"),
	]
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate
	}
	throw new Error(
		`parallel ingest: compiled worker not found (tried ${candidates.join(", ")}). Run \`npm run build\` first.`
	)
}

/**
 * Run `tasks` across a worker pool, yielding results in completion order.
 *
 * Each worker is fed one task at a time; on completion it immediately gets
 * the next unclaimed task. Worker-level crashes fail all tasks currently
 * assigned to that worker but not the run as a whole — callers are expected
 * to fall back to main-thread creation for failed paths.
 */
export async function* runIngestPool(
	tasks: IngestTask[],
	workerCount = ingestWorkerCount()
): AsyncGenerator<IngestResult> {
	if (tasks.length === 0) return

	const script = resolveWorkerScript()
	const count = Math.min(workerCount, tasks.length)

	// Results queue bridging worker callbacks -> async generator.
	const ready: IngestResult[] = []
	let wake: (() => void) | null = null
	const push = (result: IngestResult) => {
		ready.push(result)
		wake?.()
		wake = null
	}

	let nextTask = 0
	let settled = 0
	const inFlight = new Map<number, {worker: Worker; task: IngestTask}>()

	const feed = (worker: Worker): void => {
		if (nextTask >= tasks.length) return
		const seq = nextTask++
		const task = tasks[seq]
		inFlight.set(seq, {worker, task})
		const request: BuildFileDocRequest = {
			seq,
			relPath: task.relPath,
			content: task.content,
			isArtifact: task.isArtifact,
		}
		worker.postMessage(request)
	}

	const workers: Worker[] = []
	const live = new Set<Worker>()
	for (let i = 0; i < count; i++) {
		const worker = new Worker(script)
		workers.push(worker)
		live.add(worker)

		worker.on("message", (response: BuildFileDocResponse) => {
			const entry = inFlight.get(response.seq)
			if (!entry) return
			inFlight.delete(response.seq)
			settled++
			push(
				response.ok
					? {relPath: entry.task.relPath, ok: true, bytes: response.bytes}
					: {relPath: entry.task.relPath, ok: false, error: response.error}
			)
			feed(worker)
		})

		worker.on("error", error => {
			// Fail every task assigned to this worker; the rest of the pool
			// keeps going. Unclaimed tasks get picked up by other workers.
			live.delete(worker)
			for (const [seq, entry] of inFlight) {
				if (entry.worker === worker) {
					inFlight.delete(seq)
					settled++
					push({
						relPath: entry.task.relPath,
						ok: false,
						error: `worker crashed: ${error.message}`,
					})
				}
			}
			// If the whole pool died, fail the unclaimed tail rather than
			// deadlocking the generator.
			if (live.size === 0) {
				while (nextTask < tasks.length) {
					const seq = nextTask++
					settled++
					push({
						relPath: tasks[seq].relPath,
						ok: false,
						error: `worker pool exhausted: ${error.message}`,
					})
				}
			}
		})

		feed(worker)
	}

	try {
		while (settled < tasks.length || ready.length > 0) {
			if (ready.length === 0) {
				await new Promise<void>(resolve => {
					wake = resolve
				})
				continue
			}
			yield ready.shift()!
		}
	} finally {
		await Promise.allSettled(workers.map(w => w.terminate()))
	}
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
	workerCount = ingestWorkerCount()
): Promise<ShardRunOutcome> {
	const script = resolveShardWorkerScript()
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
				worker.on("exit", code => {
					if (code !== 0) fail()
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
				worker.on("exit", code => {
					if (code !== 0) fail()
					resolve()
				})
			})
		})
	)

	return outcome
}
