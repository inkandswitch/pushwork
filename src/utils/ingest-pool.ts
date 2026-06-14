/**
 * Worker pools for shared-nothing parallel ingest
 * (PUSHWORK_PARALLEL_INGEST=2 / "shard"): workers own full Repos (own
 * Wasm, own storage writes, own socket) and report only {relPath, url,
 * heads}; the main thread never materializes the docs. Background and
 * measurements: .ignore/PARALLEL_INGEST_EXPERIMENT.md.
 *
 * Worker scripts run as compiled CommonJS, so a build (`npm run build`)
 * must exist even when the engine itself runs from src via tsx.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {Worker} from "node:worker_threads"
import type {
	ShardWorkerData,
	ShardWorkerReport,
} from "../workers/shard-ingest-worker"
import type {
	CloneFromWorker,
	CloneTask,
} from "../workers/shard-clone-worker"
import type {DirectoryConfig, SyncProtocol} from "../types"

interface CloneWorkerEntry {
	worker: Worker
	ready: boolean
	doneSent: boolean
	finished: boolean
	inFlight: Map<number, CloneTask>
}

/**
 * In-flight downloads the main thread keeps queued per worker (each worker
 * owns one socket). Total in-flight across the pool is `workers * this`;
 * ~16 keeps each socket fed for latency-bound small docs without flooding
 * it for throughput-bound large docs. Env: PUSHWORK_PER_WORKER_CONCURRENCY.
 */
export const PER_WORKER_CONCURRENCY = Math.max(
	1,
	Math.floor(Number(process.env.PUSHWORK_PER_WORKER_CONCURRENCY) || 16)
)

export interface IngestTask {
	relPath: string
	content: string | Uint8Array
	isArtifact: boolean
}

export type ParallelIngestMode = "shard" | null

/**
 * Explicit shard selection. `PUSHWORK_PARALLEL_INGEST=2`/`shard` forces it
 * on; `0`/`off` forces it off (overriding the auto policy below).
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

export function shardExplicitlyDisabled(): boolean {
	const v = process.env.PUSHWORK_PARALLEL_INGEST
	return v === "0" || v === "off"
}

/**
 * Worker-count floor below which spinning up shard workers (each ~1 s of
 * Wasm + Repo init) doesn't pay for itself versus the main-thread path.
 * Tuned empirically: the per-doc network/transfer cost only dominates
 * worker startup past a few dozen docs.
 */
export const AUTO_SHARD_THRESHOLD = 64

/**
 * Online worker cap. cores−1 (=23 here) triggered an EMFILE death spiral
 * during the post-upload save storm (see CLAUDE.md); 8 was clean.
 */
export const SHARD_WORKER_CAP = 8

/**
 * Whether a clone/pull/push of `docCount` new documents should use the
 * shard workers. Explicit `=2` always wins; explicit `0`/`off` always
 * declines; otherwise auto-enable past the threshold.
 */
export function shouldAutoShard(docCount: number): boolean {
	if (parallelIngestMode() === "shard") return true
	if (shardExplicitlyDisabled()) return false
	return docCount >= AUTO_SHARD_THRESHOLD
}

/**
 * Whether change detection should emit URL-only (deferred) changes for
 * new *clean* remote files (no local copy) instead of materializing them —
 * required for the shard-pull path. The doc count isn't known until the
 * tree is walked, so we defer whenever sharding is possible and let the
 * pull phase decide shard-vs-main-thread by the discovered count: a clone
 * (empty snapshot) or an incremental sync that pulls a peer's newly-added
 * subtree both benefit. Below AUTO_SHARD_THRESHOLD the pull falls back to
 * the main thread, so deferring a handful of files costs nothing.
 *
 * `snapshotFileCount` is retained for callers that want the historical
 * empty-snapshot-only behaviour; it no longer gates the default path.
 */
export function shouldDeferRemoteContent(_snapshotFileCount?: number): boolean {
	if (shardExplicitlyDisabled()) return false
	return true
}

export function ingestWorkerCount(): number {
	const fromEnv = Number(process.env.PUSHWORK_WORKERS)
	if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
	return Math.min(
		SHARD_WORKER_CAP,
		Math.max(1, (os.cpus()?.length ?? 4) - 1)
	)
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
	// Called with the file count each worker reports (workers report once,
	// after their whole shard is built + uploaded), so the caller can drive
	// a progress bar. Granularity is per-shard, not per-file.
	onProgress?: (done: number) => void,
	workerScript?: string // test seam: stub script exercising failure paths
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
					onProgress?.(report.results.length)
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
 * Streaming, work-stealing clone-pull pool. Workers spawn once and
 * idle-wait; the main thread feeds download tasks (via `submit`, which
 * can be called incrementally as a directory walk discovers files — see
 * the engine's streaming clone path) and caps each worker at
 * `PER_WORKER_CONCURRENCY` in flight. Idle workers naturally pick up the
 * next queued task, so a worker stuck on a big file doesn't starve the
 * others (the static round-robin partition it replaced did).
 *
 * A crashed worker's in-flight tasks land in `failedPaths` (the caller
 * runs the main-thread fallback). Undispatched queue items are still
 * picked up by surviving workers; only when ALL workers are gone do the
 * remaining queue items fail.
 */
export class StreamingClonePool {
	#workers: CloneWorkerEntry[] = []

	#queue: CloneTask[] = []
	#results: ClonePullOutcome[] = []
	#failedPaths: string[] = []
	#seq = 0
	#finishing = false
	#finishResolve: (() => void) | null = null

	constructor(
		workingDir: string,
		config: DirectoryConfig,
		protocol: SyncProtocol,
		workerCount: number,
		private onResult?: (result: ClonePullOutcome) => void
	) {
		const script = resolveCloneWorkerScript()
		const count = Math.max(1, workerCount)
		for (let i = 0; i < count; i++) {
			const worker = new Worker(script, {
				workerData: {workingDir, config, protocol},
			})
			const entry = {
				worker,
				ready: false,
				doneSent: false,
				finished: false,
				inFlight: new Map<number, CloneTask>(),
			}
			this.#workers.push(entry)
			worker.on("message", (msg: CloneFromWorker) =>
				this.#onMessage(entry, msg)
			)
			worker.on("error", () => this.#onDead(entry))
			worker.on("exit", () => this.#onDead(entry))
		}
	}

	/** Queue a file for download; dispatched to an idle worker slot. */
	submit(task: CloneTask): void {
		this.#queue.push(task)
		this.#dispatch()
	}

	/**
	 * Signal that no more tasks will be submitted. Resolves once every
	 * worker has drained its in-flight work and shut down (or died).
	 */
	async finish(): Promise<ClonePullRunOutcome> {
		this.#finishing = true
		this.#maybeSendDone()
		await new Promise<void>(resolve => {
			this.#finishResolve = resolve
			this.#checkAllFinished()
		})
		return {results: this.#results, failedPaths: this.#failedPaths}
	}

	#dispatch(): void {
		for (const w of this.#workers) {
			if (w.finished || !w.ready) continue
			while (w.inFlight.size < PER_WORKER_CONCURRENCY && this.#queue.length > 0) {
				const task = this.#queue.shift()!
				const seq = this.#seq++
				w.inFlight.set(seq, task)
				w.worker.postMessage({type: "task", seq, task})
			}
		}
	}

	#onMessage(
		w: CloneWorkerEntry,
		msg: CloneFromWorker
	): void {
		switch (msg.type) {
			case "ready":
				w.ready = true
				this.#dispatch()
				this.#maybeSendDone()
				break
			case "result":
				w.inFlight.delete(msg.seq)
				this.#results.push(msg.result)
				this.onResult?.(msg.result)
				this.#dispatch() // refill this worker's freed slot
				this.#maybeSendDone()
				break
			case "finished":
				w.finished = true
				void w.worker.terminate()
				this.#checkAllFinished()
				break
		}
	}

	/** A worker died (error/exit) before reporting all its in-flight tasks. */
	#onDead(w: CloneWorkerEntry): void {
		if (w.finished) return // clean termination after "finished"
		w.finished = true
		for (const task of w.inFlight.values()) {
			this.#failedPaths.push(task.relPath)
		}
		w.inFlight.clear()
		// Surviving workers can still take queued items; but if this was the
		// last one, the queue can never drain — fail the remainder.
		if (this.#workers.every(x => x.finished)) {
			for (const task of this.#queue) this.#failedPaths.push(task.relPath)
			this.#queue.length = 0
		} else {
			this.#dispatch()
		}
		this.#checkAllFinished()
	}

	#maybeSendDone(): void {
		if (!this.#finishing || this.#queue.length > 0) return
		for (const w of this.#workers) {
			if (!w.finished && !w.doneSent && w.ready && w.inFlight.size === 0) {
				w.doneSent = true
				w.worker.postMessage({type: "done"})
			}
		}
	}

	#checkAllFinished(): void {
		if (this.#finishResolve && this.#workers.every(w => w.finished)) {
			this.#finishResolve()
			this.#finishResolve = null
		}
	}
}

/**
 * Convenience wrapper: download `tasks` through a {@link StreamingClonePool}
 * with no pipelining (submit everything up front, then finish). Used where
 * the full task list is already known.
 */
export async function runShardPull(
	workingDir: string,
	config: DirectoryConfig,
	protocol: SyncProtocol,
	tasks: ClonePullTask[],
	workerCount = ingestWorkerCount(),
	// Called once per file as it's downloaded, for a progress bar.
	onProgress?: (done: number) => void
): Promise<ClonePullRunOutcome> {
	const count = Math.min(workerCount, tasks.length)
	const pool = new StreamingClonePool(
		workingDir,
		config,
		protocol,
		count,
		onProgress ? () => onProgress(1) : undefined
	)
	for (const task of tasks) pool.submit(task)
	return pool.finish()
}
