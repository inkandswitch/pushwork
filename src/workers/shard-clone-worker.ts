/**
 * Shared-nothing shard-clone worker (parallel-ingest experiment, mode
 * PUSHWORK_PARALLEL_INGEST=2 / "shard") — the pull/clone mirror of
 * shard-ingest-worker.
 *
 * Each worker owns a FULL Repo (own Wasm, own storage adapter on the
 * shared `.pushwork/automerge` directory, own WebSocket when online).
 * It `repo.find`s its shard of remote file documents — downloading
 * and/or loading + materializing them with its own Wasm instance —
 * writes the content to the local filesystem itself, and reports only
 * `{relPath, url, heads, contentHash}`. The main thread never
 * materializes the documents; it records the reported values in the
 * snapshot. This is darn's clone shape: directory walk serial on main
 * (parent before child), leaf fetches wide in parallel.
 */

import {parentPort, workerData} from "node:worker_threads"
import * as path from "node:path"
import type {AutomergeUrl, DocHandle, UrlHeads} from "@automerge/automerge-repo"
import {createRepo} from "../utils/repo-factory"
import {getPlainUrl} from "../utils/directory"
import {writeFileContent} from "../utils/fs"
import {readDocContent} from "../utils/text-diff"
import {contentHash} from "../utils/content"
import type {DirectoryConfig, FileDocument, SyncProtocol} from "../types"

export interface CloneTask {
	relPath: string
	/** Directory entry URL (possibly versioned for artifacts). */
	url: string
}

export interface CloneWorkerData {
	workingDir: string
	config: DirectoryConfig
	protocol: SyncProtocol
	tasks: CloneTask[]
}

export type CloneFileResult =
	| {
			relPath: string
			ok: true
			url: string
			heads: UrlHeads
			isText: boolean
			contentHash: string
	  }
	| {relPath: string; ok: false; error: string}

export interface CloneWorkerReport {
	results: CloneFileResult[]
}

const FIND_RETRIES = 5
const FIND_RETRY_DELAY_MS = 300

const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** repo.find with retry — freshly-shared docs can be briefly unavailable. */
async function findWithRetry(
	repo: Awaited<ReturnType<typeof createRepo>>,
	url: string
): Promise<DocHandle<FileDocument>> {
	let lastError: unknown
	for (let attempt = 0; attempt < FIND_RETRIES; attempt++) {
		try {
			return await repo.find<FileDocument>(url as AutomergeUrl)
		} catch (error) {
			lastError = error
			await pause(FIND_RETRY_DELAY_MS)
		}
	}
	throw lastError
}

async function run(): Promise<void> {
	const {workingDir, config, protocol, tasks} = workerData as CloneWorkerData

	const repo = await createRepo(workingDir, config, protocol, {
		skipCorruptScan: true,
	})

	const results: CloneFileResult[] = []

	for (const task of tasks) {
		try {
			const plainUrl = getPlainUrl(task.url as AutomergeUrl)
			const handle = await findWithRetry(repo, plainUrl)
			const doc = handle.doc()
			const content = readDocContent(doc?.content)
			if (content === null) {
				throw new Error("document has no readable content")
			}

			await writeFileContent(path.join(workingDir, task.relPath), content)

			results.push({
				relPath: task.relPath,
				ok: true,
				url: plainUrl,
				heads: handle.heads(),
				isText: typeof content === "string",
				contentHash: contentHash(content),
			})
		} catch (error) {
			results.push({
				relPath: task.relPath,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	// Persist downloaded docs to the shared storage directory so future
	// syncs (main repo) can load them locally.
	await repo.shutdown()

	const report: CloneWorkerReport = {results}
	parentPort!.postMessage(report)
}

run().catch(error => {
	console.error("[pushwork:shard-clone-worker] fatal:", error)
	process.exit(1)
})
