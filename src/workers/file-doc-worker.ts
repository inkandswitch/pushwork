/**
 * Worker thread that builds Automerge file documents off the main thread.
 *
 * Part of the parallel-ingest experiment (PUSHWORK_PARALLEL_INGEST=1): the
 * expensive CRDT construction for NEW files — `A.from` plus the per-character
 * text splice — runs here, in a pool of workers each owning its own Wasm
 * instance. The document is serialized with `A.save` and shipped back as
 * transferable bytes; the main thread re-materializes it with
 * `repo.import(bytes, {docId})`, which is a (much cheaper) `A.load`.
 *
 * The document shape must stay byte-for-byte semantically identical to
 * `SyncEngine.createRemoteFile`:
 *   - artifact text  -> content stored as RawString (immutable snapshot)
 *   - normal text    -> content "" in the initial doc, then spliced in a
 *                       second change (collaborative text)
 *   - binary         -> content as raw bytes
 */

import * as A from "@automerge/automerge"
import {parentPort} from "node:worker_threads"
import {getFileExtension} from "../utils/fs"
import {getEnhancedMimeType} from "../utils/mime-types"
import {updateTextContent} from "../utils/text-diff"

export interface BuildFileDocRequest {
	seq: number
	/** Repo-relative path (used for name/extension/mime derivation). */
	relPath: string
	content: string | Uint8Array
	isArtifact: boolean
}

export type BuildFileDocResponse =
	| {seq: number; ok: true; bytes: Uint8Array}
	| {seq: number; ok: false; error: string}

/** Mirrors the FileDocument construction in SyncEngine.createRemoteFile. */
export function buildFileDocBytes(req: BuildFileDocRequest): Uint8Array {
	const {relPath, content, isArtifact} = req
	const isText = typeof content === "string"

	let doc = A.from({
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
	})

	if (isText && !isArtifact) {
		doc = A.change(doc, d => {
			updateTextContent(d, ["content"], content)
		})
	}

	return A.save(doc)
}

if (parentPort) {
	const port = parentPort
	port.on("message", (req: BuildFileDocRequest) => {
		try {
			const bytes = buildFileDocBytes(req)
			const response: BuildFileDocResponse = {seq: req.seq, ok: true, bytes}
			const transfer =
				bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : []
			port.postMessage(response, transfer)
		} catch (error) {
			const response: BuildFileDocResponse = {
				seq: req.seq,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			}
			port.postMessage(response)
		}
	})
}
