/**
 * Shared-nothing shard-clone worker (PUSHWORK_PARALLEL_INGEST=shard).
 *
 * Mirror of the ingest worker for the pull side. Each worker owns a full Repo
 * (own Wasm, own storage view, own WebSocket online) and handles its shard of
 * file leaves end-to-end: `repo.find` the document (download online / load
 * from shared storage offline), read its content, and write the file to disk
 * itself. It reports which relative paths it wrote; the main thread never
 * materializes these documents.
 *
 * Runs as compiled CommonJS (dist/workers/...), spawned by ../ingest-pool.
 */
import * as path from "path";
import { parentPort, workerData } from "worker_threads";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import { storageDir, type Backend } from "../config.js";
import { writeFileAtomic } from "../fs-tree.js";
import { openRepo } from "../repo.js";
import { findFileEntry } from "../shapes/index.js";

export type ShardCloneData = {
	root: string;
	backend: Backend;
	online: boolean;
	leaves: [relPath: string, url: AutomergeUrl][];
};

export type ShardCloneReport = { written: string[]; failed: string[] };

const fromPosix = (p: string) => p.split("/").join(path.sep);

async function run(): Promise<void> {
	const { root, backend, online, leaves } = workerData as ShardCloneData;
	const repo = await openRepo(backend, storageDir(root), { offline: !online });

	const written: string[] = [];
	const failed: string[] = [];
	try {
		for (const [relPath, url] of leaves) {
			try {
				const { bytes } = await findFileEntry(repo, url);
				await writeFileAtomic(path.join(root, fromPosix(relPath)), bytes);
				written.push(relPath);
			} catch {
				failed.push(relPath);
			}
		}
	} finally {
		await repo.shutdown();
	}

	parentPort!.postMessage({ written, failed } satisfies ShardCloneReport);
}

run().catch((error) => {
	console.error("[pushwork:shard-clone] fatal:", error);
	process.exit(1);
});
