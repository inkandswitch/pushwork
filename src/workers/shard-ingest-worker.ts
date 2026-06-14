/**
 * Shared-nothing shard-ingest worker (parallel-ingest experiment, mode
 * PUSHWORK_PARALLEL_INGEST=2 / "shard").
 *
 * Each worker owns a full Repo — its own Wasm instance, its own
 * NodeFSStorageAdapter writing to the same `.pushwork/automerge`
 * directory (document keys are disjoint, atomic-rename writes are
 * multi-writer safe), and, when sync is enabled, its own WebSocket to
 * the sync server.
 *
 * The worker ingests its shard of new files end-to-end: build doc →
 * persist to shared storage → upload to the server → wait for delivery.
 * It reports only `{relPath, url, heads}` per file; the main thread
 * never materializes these documents, stitching the reported URLs into
 * directory documents afterwards ("parallel leaves, serial directories"),
 * which preserves children-before-parents ordering on the server.
 */

import {parentPort, workerData} from "node:worker_threads"
import * as A from "@automerge/automerge"
import type {DocHandle, UrlHeads} from "@automerge/automerge-repo"
import {createRepo} from "../utils/repo-factory"
import {waitForSync} from "../utils/network-sync"
import {getFileExtension} from "../utils/fs"
import {getEnhancedMimeType} from "../utils/mime-types"
import {updateTextContent} from "../utils/text-diff"
import type {DirectoryConfig, FileDocument, SyncProtocol} from "../types"
import {out} from "../utils/output"

export interface ShardTask {
	relPath: string
	content: string | Uint8Array
	isArtifact: boolean
}

export interface ShardWorkerData {
	workingDir: string
	config: DirectoryConfig
	protocol: SyncProtocol
	tasks: ShardTask[]
}

export type ShardFileResult =
	| {relPath: string; ok: true; url: string; heads: UrlHeads}
	| {relPath: string; ok: false; error: string}

export interface ShardWorkerReport {
	results: ShardFileResult[]
	/** Paths that did not converge to the server within the wait budget. */
	unsynced: string[]
}

/** Mirrors the FileDocument construction in SyncEngine.createRemoteFile. */
function buildFileDoc(task: ShardTask): FileDocument {
	const {relPath, content, isArtifact} = task
	const isText = typeof content === "string"
	return {
		"@patchwork": {type: "file"},
		name: relPath.split("/").pop() || "",
		extension: getFileExtension(relPath),
		mimeType: getEnhancedMimeType(relPath),
		content:
			isText && isArtifact
				? (new A.RawString(content) as unknown as string)
				: isText
					? ""
					: content,
		metadata: {
			permissions: 0o644,
		},
	}
}

async function run(): Promise<void> {
	// Workers share the parent's terminal: spinners/progress bars from N
	// threads would garble the display, so run quiet (errors still print).
	out.configure({verbosity: "quiet"})
	const {workingDir, config, protocol, tasks} = workerData as ShardWorkerData

	const repo = await createRepo(workingDir, config, protocol, {
		skipCorruptScan: true,
	})

	const results: ShardFileResult[] = []
	const handlesByPath = new Map<string, DocHandle<FileDocument>>()

	for (const task of tasks) {
		try {
			const handle = repo.create<FileDocument>(buildFileDoc(task))
			if (typeof task.content === "string" && !task.isArtifact) {
				handle.change((doc: FileDocument) => {
					updateTextContent(doc, ["content"], task.content as string)
				})
			}
			handlesByPath.set(task.relPath, handle)
			results.push({
				relPath: task.relPath,
				ok: true,
				url: handle.url,
				heads: handle.heads(),
			})
		} catch (error) {
			results.push({
				relPath: task.relPath,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	// Upload: wait until this shard's documents reach the server. The main
	// thread builds directory documents only after every worker reports,
	// so children are on the server before any parent references them.
	const unsynced: string[] = []
	if (config.sync_enabled && config.sync_server && handlesByPath.size > 0) {
		const storageId =
			protocol === "legacy" ? config.sync_server_storage_id : undefined
		const {failed} = await waitForSync(
			Array.from(handlesByPath.values()),
			storageId
		)
		const failedUrls = new Set(failed.map(h => h.url))
		for (const [relPath, handle] of handlesByPath) {
			if (failedUrls.has(handle.url)) unsynced.push(relPath)
		}
	}

	// Flush pending storage writes (and close the socket) before reporting.
	const shutdownStart = Date.now()
	await repo.shutdown()
	if (process.env.DEBUG) {
		console.error(
			`[pushwork:shard-worker] shutdown took ${Date.now() - shutdownStart}ms`
		)
	}

	const report: ShardWorkerReport = {results, unsynced}
	parentPort!.postMessage(report)
}

run().catch(error => {
	// Nonzero exit surfaces as the pool's shard-failure path.
	console.error("[pushwork:shard-worker] fatal:", error)
	process.exit(1)
})
