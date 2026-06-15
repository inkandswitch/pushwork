/**
 * Shared-nothing shard-clone worker (the pull/clone leaf downloader).
 *
 * Streaming protocol: the worker owns a full Repo (own Wasm, own storage
 * adapter on the shared `.pushwork/automerge` dir, own WebSocket) and
 * processes download tasks PUSHED by the main thread one message at a
 * time, reporting each result as it completes. The main thread caps how
 * many tasks each worker has in flight (work-stealing concurrency control
 * lives there, not here), so this side is a dumb async processor:
 *
 *   main → {type:"task", seq, task}   worker downloads + writes the file
 *   worker → {type:"result", seq, result}
 *   main → {type:"done"}              no more tasks coming
 *   worker → {type:"finished"}        after in-flight drains + shutdown
 *
 * Pushing tasks (rather than a static list at startup) lets the main
 * thread (a) feed tasks as the directory walk discovers them (pipelining
 * the walk with the download) and (b) keep faster workers busy when a slow
 * worker is stuck on a big file (work-stealing).
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
import {out} from "../utils/output"

export interface CloneTask {
	relPath: string
	/** Directory entry URL (possibly versioned for artifacts). */
	url: string
}

export interface CloneWorkerData {
	workingDir: string
	config: DirectoryConfig
	protocol: SyncProtocol
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

/** Main → worker messages. */
export type CloneToWorker =
	| {type: "task"; seq: number; task: CloneTask}
	| {type: "done"}

/** Worker → main messages. */
export type CloneFromWorker =
	| {type: "ready"}
	| {type: "result"; seq: number; result: CloneFileResult}
	| {type: "finished"}

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

async function downloadOne(
	repo: Awaited<ReturnType<typeof createRepo>>,
	workingDir: string,
	task: CloneTask
): Promise<CloneFileResult> {
	try {
		const plainUrl = getPlainUrl(task.url as AutomergeUrl)
		const handle = await findWithRetry(repo, plainUrl)
		const doc = handle.doc()
		const content = readDocContent(doc?.content)
		if (content === null) {
			throw new Error("document has no readable content")
		}
		await writeFileContent(path.join(workingDir, task.relPath), content)
		return {
			relPath: task.relPath,
			ok: true,
			url: plainUrl,
			heads: handle.heads(),
			isText: typeof content === "string",
			contentHash: contentHash(content),
		}
	} catch (error) {
		return {
			relPath: task.relPath,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

async function run(): Promise<void> {
	// Workers share the parent's terminal: spinners/progress bars from N
	// threads would garble the display, so run quiet (errors still print).
	out.configure({verbosity: "quiet"})
	const {workingDir, config, protocol} = workerData as CloneWorkerData

	const repo = await createRepo(workingDir, config, protocol, {
		skipCorruptScan: true,
	})

	let active = 0
	let doneSignaled = false

	const post = (msg: CloneFromWorker) => parentPort!.postMessage(msg)

	const maybeFinish = (): void => {
		if (doneSignaled && active === 0) {
			// Persist downloaded docs to shared storage so the main repo
			// can load them locally, then signal teardown complete.
			void repo.shutdown().then(() => {
				post({type: "finished"})
			})
		}
	}

	parentPort!.on("message", (msg: CloneToWorker) => {
		if (msg.type === "done") {
			doneSignaled = true
			maybeFinish()
			return
		}
		// type === "task"
		active++
		void downloadOne(repo, workingDir, msg.task).then(result => {
			post({type: "result", seq: msg.seq, result})
			active--
			maybeFinish()
		})
	})

	// Announce readiness so the main thread starts feeding tasks.
	post({type: "ready"})
}

run().catch(error => {
	console.error("[pushwork:shard-clone-worker] fatal:", error)
	process.exit(1)
})
