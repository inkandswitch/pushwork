/**
 * Worker pools for shared-nothing parallel ingest / clone
 * (PUSHWORK_PARALLEL_INGEST=shard).
 *
 * Each worker owns a full Repo (own Wasm, own storage writes, own socket) and
 * reports only URLs/heads (push) or which files it wrote (clone); the main
 * thread never materializes the file documents. New files / leaves are split
 * round-robin across a bounded pool, and a per-worker failure falls back to
 * main-thread handling rather than failing the whole operation.
 *
 * The worker scripts run as compiled CommonJS sitting next to this module
 * (dist/workers/...), so a build must exist even when the engine runs from
 * source via tsx.
 */
import * as os from "os";
import * as path from "path";
import { Worker } from "worker_threads";
import {
	parseAutomergeUrl,
	stringifyAutomergeUrl,
	type AutomergeUrl,
	type UrlHeads,
} from "@automerge/automerge-repo";
import type { Backend } from "./config.js";
import { log } from "./log.js";
import { isInArtifactDir } from "./shapes/index.js";
import type {
	ShardIngestData,
	ShardIngestReport,
	ShardIngestTask,
} from "./workers/shard-ingest-worker.js";
import type {
	ShardCloneData,
	ShardCloneReport,
} from "./workers/shard-clone-worker.js";

const dlog = log("ingest-pool");

// Higher worker counts exhaust file descriptors during the online upload
// storm (EMFILE). Overridable for experiments via PUSHWORK_WORKERS.
const SHARD_WORKER_CAP = Math.max(
	1,
	Math.floor(Number(process.env.PUSHWORK_WORKERS) || 8),
);

// Below this many items, spinning up workers (each ~1s of Wasm + Repo init)
// doesn't pay for itself versus the main-thread path.
const SHARD_MIN_ITEMS = 8;

type ExplicitMode = "on" | "off" | null;

// `PUSHWORK_PARALLEL_INGEST=shard`/`2` forces the pools on; `off`/`0` forces
// them off; anything else leaves the adaptive policy in charge.
function explicitMode(): ExplicitMode {
	const v = process.env.PUSHWORK_PARALLEL_INGEST;
	if (v === "shard" || v === "2") return "on";
	if (v === "off" || v === "0") return "off";
	return null;
}

/**
 * Whether to shard an ingest of `itemCount` files. Count-based, symmetric with
 * `shouldShardClone`: shard past the item floor unless explicitly disabled.
 * Parallel ingest keeps the op-tree build AND the per-doc sync round-trips off
 * the main thread, which wins for many files regardless of per-file size.
 */
export function shouldShardIngest(itemCount: number): boolean {
	if (itemCount < SHARD_MIN_ITEMS) return false;
	return explicitMode() !== "off";
}

/**
 * Whether to shard a clone/materialize of `leafCount` files. Parallel
 * download/read wins broadly (the serial path pays a per-file `repo.find`), so
 * auto-enable past the floor; explicit `off`/`0` still declines.
 */
export function shouldShardClone(leafCount: number): boolean {
	if (leafCount < SHARD_MIN_ITEMS) return false;
	return explicitMode() !== "off";
}

function workerCount(itemCount: number): number {
	const cores = Math.max(1, (os.cpus()?.length ?? 1) - 1);
	return Math.max(1, Math.min(SHARD_WORKER_CAP, cores, itemCount));
}

// Worker scripts are compiled next to this module: dist/ingest-pool.js +
// dist/workers/<name>.js (or dist-bench/src/... under the bench build).
function workerPath(name: string): string {
	return path.join(__dirname, "workers", name);
}

function partition<T>(items: T[], buckets: number): T[][] {
	const out: T[][] = Array.from({ length: buckets }, () => []);
	items.forEach((item, i) => out[i % buckets].push(item));
	return out;
}

function pinFromHeads(url: AutomergeUrl, heads: string[]): AutomergeUrl {
	const { documentId } = parseAutomergeUrl(url);
	return stringifyAutomergeUrl({ documentId, heads: heads as UrlHeads });
}

// Spawn a worker, resolve with its single report message, and terminate it
// eagerly on report (the report is sent strictly after the worker's storage
// flush / shutdown, so nothing of value remains — and a leftover sync timer
// would otherwise keep the worker's event loop alive long after shutdown).
function runWorker<TData, TReport>(
	scriptPath: string,
	workerData: TData,
): Promise<TReport> {
	return new Promise<TReport>((resolve, reject) => {
		const worker = new Worker(scriptPath, { workerData });
		let settled = false;
		worker.once("message", (msg: TReport) => {
			settled = true;
			void worker.terminate();
			resolve(msg);
		});
		worker.once("error", (err) => {
			settled = true;
			reject(err);
		});
		worker.once("exit", (code) => {
			if (!settled) reject(new Error(`worker exited with code ${code}`));
		});
	});
}

export type ShardIngestOpts = {
	root: string;
	backend: Backend;
	online: boolean;
	files: Map<string, Uint8Array>;
	artifactDirs: readonly string[];
};

/**
 * Create file documents for `files` across the worker pool. Returns the URLs
 * the workers created (artifact paths pinned to their reported heads) keyed by
 * posix path, plus the paths a worker could not create (caller materializes
 * those on the main thread).
 */
export async function shardIngest(
	opts: ShardIngestOpts,
): Promise<{ created: Map<string, AutomergeUrl>; failed: string[] }> {
	const tasks: ShardIngestTask[] = Array.from(opts.files, ([relPath, bytes]) => ({
		relPath,
		bytes,
		isArtifact: isInArtifactDir(relPath, opts.artifactDirs),
	}));
	const n = workerCount(tasks.length);
	dlog("shardIngest files=%d workers=%d online=%s", tasks.length, n, opts.online);

	const reports = await Promise.all(
		partition(tasks, n).map((shard) =>
			runWorker<ShardIngestData, ShardIngestReport>(
				workerPath("shard-ingest-worker.js"),
				{ root: opts.root, backend: opts.backend, online: opts.online, tasks: shard },
			).catch((err): ShardIngestReport => {
				dlog("ingest worker failed, falling back to main: %s", err);
				return {
					results: shard.map((t) => ({
						relPath: t.relPath,
						ok: false,
						error: String(err),
					})),
				};
			}),
		),
	);

	const created = new Map<string, AutomergeUrl>();
	const failed: string[] = [];
	for (const report of reports) {
		for (const r of report.results) {
			if (r.ok) {
				created.set(r.relPath, r.isArtifact ? pinFromHeads(r.url, r.heads) : r.url);
			} else {
				failed.push(r.relPath);
			}
		}
	}
	dlog("shardIngest created=%d failed=%d", created.size, failed.length);
	return { created, failed };
}

export type ShardCloneOpts = {
	root: string;
	backend: Backend;
	online: boolean;
	leaves: Map<string, AutomergeUrl>;
};

/**
 * Write the `leaves` (posix path → file-doc URL) to disk across the worker
 * pool. Returns the paths workers wrote and the paths they could not (caller
 * materializes those on the main thread).
 */
export async function shardClone(
	opts: ShardCloneOpts,
): Promise<{ written: Set<string>; failed: string[] }> {
	const entries = Array.from(opts.leaves) as [string, AutomergeUrl][];
	const n = workerCount(entries.length);
	dlog("shardClone leaves=%d workers=%d online=%s", entries.length, n, opts.online);

	const reports = await Promise.all(
		partition(entries, n).map((shard) =>
			runWorker<ShardCloneData, ShardCloneReport>(
				workerPath("shard-clone-worker.js"),
				{ root: opts.root, backend: opts.backend, online: opts.online, leaves: shard },
			).catch((err): ShardCloneReport => {
				dlog("clone worker failed, falling back to main: %s", err);
				return { written: [], failed: shard.map(([relPath]) => relPath) };
			}),
		),
	);

	const written = new Set<string>();
	const failed: string[] = [];
	for (const report of reports) {
		for (const p of report.written) written.add(p);
		for (const p of report.failed) failed.push(p);
	}
	dlog("shardClone written=%d failed=%d", written.size, failed.length);
	return { written, failed };
}
