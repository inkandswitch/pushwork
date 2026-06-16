/**
 * Shared-nothing shard-ingest worker (PUSHWORK_PARALLEL_INGEST=shard).
 *
 * Each worker owns a full Repo — its own Wasm instance, its own
 * NodeFSStorageAdapter writing the same `.pushwork/storage` directory
 * (document keys are disjoint and writes are atomic-rename, so concurrent
 * workers are safe), and, when online, its own WebSocket to the sync server.
 *
 * The worker creates its shard of new file documents end-to-end (build doc →
 * persist to shared storage → upload), then reports only `{relPath, url,
 * heads}` per file. The main thread never materializes these documents; it
 * stitches the reported URLs into the folder document afterwards ("parallel
 * leaves, serial directories"), so children reach the server before parents.
 *
 * Runs as compiled CommonJS (dist/workers/...), spawned by ../ingest-pool.
 */
import { parentPort, workerData } from "worker_threads";
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { storageDir, type Backend } from "../config.js";
import { openRepo, waitForSync } from "../repo.js";
import { makeFileEntry, type UnixFileEntry } from "../shapes/index.js";

export type ShardIngestTask = {
	relPath: string;
	bytes: Uint8Array;
	isArtifact: boolean;
};

export type ShardIngestData = {
	root: string;
	backend: Backend;
	online: boolean;
	tasks: ShardIngestTask[];
};

export type ShardFileResult =
	| {
			relPath: string;
			ok: true;
			url: AutomergeUrl;
			heads: string[];
			isArtifact: boolean;
	  }
	| { relPath: string; ok: false; error: string };

export type ShardIngestReport = { results: ShardFileResult[] };

async function run(): Promise<void> {
	const { root, backend, online, tasks } = workerData as ShardIngestData;
	const repo = await openRepo(backend, storageDir(root), { offline: !online });

	const results: ShardFileResult[] = [];
	let lastHandle: DocHandle<UnixFileEntry> | undefined;
	try {
		for (const task of tasks) {
			try {
				const entry = makeFileEntry(task.relPath, task.bytes, task.isArtifact);
				const handle = repo.create<UnixFileEntry>(entry);
				lastHandle = handle;
				results.push({
					relPath: task.relPath,
					ok: true,
					url: handle.url,
					heads: handle.heads() ?? [],
					isArtifact: task.isArtifact,
				});
			} catch (error) {
				results.push({
					relPath: task.relPath,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Online: local head-stability is NOT a server-delivery guarantee, but
		// it gives the repo a sync window (minMs floor) to connect and upload
		// this shard's documents; the shutdown quiesce then finalizes delivery.
		// Without this window the worker would shut down before its socket even
		// connected, leaving its file docs undelivered (clone → "unavailable").
		if (online && lastHandle) {
			await waitForSync(lastHandle, { minMs: 3000, idleMs: 1500, maxMs: 15000 });
		}
	} finally {
		// Flush storage (and, online, quiesce-deliver to the server) before
		// reporting. The pool terminates the worker on the report message, so
		// nothing of value may remain after this resolves.
		await repo.shutdown();
	}

	parentPort!.postMessage({ results } satisfies ShardIngestReport);
}

run().catch((error) => {
	console.error("[pushwork:shard-ingest] fatal:", error);
	process.exit(1);
});
