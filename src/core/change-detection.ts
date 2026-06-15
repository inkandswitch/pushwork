import {
	AutomergeUrl,
	DocHandle,
	Repo,
	UrlHeads,
} from "@automerge/automerge-repo"
import * as A from "@automerge/automerge"
import {
	ChangeType,
	FileType,
	SyncSnapshot,
	SnapshotFileEntry,
	FileDocument,
	DirectoryDocument,
	DetectedChange,
} from "../types"
import {
	readFileContent,
	listDirectory,
	getRelativePath,
	joinAndNormalizePath,
	getPlainUrl,
	readDocContent,
} from "../utils"
import {isContentEqual, contentHash} from "../utils/content"
import {out} from "../utils/output"
import {profileAsync, count} from "../utils/profile"
import {mapWithConcurrency, IO_CONCURRENCY, makeYielder} from "../utils/concurrency"

const isDebug = !!process.env.DEBUG
function debug(...args: any[]) {
	if (isDebug) console.error("[pushwork:change-detection]", ...args)
}

/**
 * Shared state threaded through the remote tree walk so each recursion
 * doesn't restate the full argument list.
 */
interface RemoteWalkContext {
	snapshot: SyncSnapshot
	changes: DetectedChange[]
	// Snapshot's direct children indexed by parent directory path, for
	// remote-deletion detection without a global scan.
	childFiles: Map<string, Set<string>>
	childDirs: Map<string, Set<string>>
	excludePaths?: Set<string>
	freshPaths?: Set<string>
	deferRemoteContent?: boolean
	onProgress?: (discovered: number) => void
	maybeYield: () => Promise<void>
}

/**
 * Change detection engine
 */
export class ChangeDetector {
	constructor(
		private repo: Repo,
		private rootPath: string,
		private excludePatterns: string[] = [],
		private artifactDirectories: string[] = []
	) {}

	/**
	 * Check if a file path is inside an artifact directory.
	 * Artifact files use RawString and are always replaced wholesale,
	 * so we can skip expensive remote content reads for them.
	 */
	private isArtifactPath(filePath: string): boolean {
		return this.artifactDirectories.some(
			dir => filePath === dir || filePath.startsWith(dir + "/")
		)
	}

	/**
	 * Detect all changes between local filesystem and snapshot.
	 *
	 * Shard-mode (PUSHWORK_PARALLEL_INGEST=2) params:
	 * - `freshPaths`: paths just pushed by worker-owned repos. Their snapshot
	 *   heads are already current; materializing their docs on the main
	 *   thread would reinstate the serial cost the workers exist to avoid,
	 *   so both local and remote detection skip them for this run.
	 * - `deferRemoteContent`: emit URL-only changes for new remote files
	 *   (no doc materialization); shard-pull workers fetch them.
	 *
	 * `onRemoteProgress(n)` is called as remote documents are discovered
	 * (the clone/pull download), so callers can show a live count.
	 */
	async detectChanges(
		snapshot: SyncSnapshot,
		excludePaths?: Set<string>,
		precomputedFiles?: Map<string, {content: string | Uint8Array; type: FileType}>,
		freshPaths?: Set<string>,
		deferRemoteContent?: boolean,
		onRemoteProgress?: (discovered: number) => void
	): Promise<DetectedChange[]> {
		const changes: DetectedChange[] = []

		// Get current filesystem state (reuse a caller-provided scan when
		// given — the local FS doesn't change between the pre-push and
		// post-network detect passes).
		const currentFiles =
			precomputedFiles ??
			(await profileAsync("detect:fs-scan", () =>
				this.getCurrentFilesystemState()
			))

		// Check for local changes (new, modified, deleted files)
		const localChanges = await profileAsync("detect:local", () =>
			this.detectLocalChanges(snapshot, currentFiles, freshPaths)
		)
		changes.push(...localChanges)

		// Remote-change detection.
		//
		// Populated snapshot (incremental sync / watch tick): one tree walk
		// that visits each directory once (detectRemoteTreeWalk).
		//
		// Empty snapshot (clone / fresh track): the discovery walk (which also
		// feeds the streaming-clone and shard-pull deferral).
		if (snapshot.files.size === 0) {
			const newRemoteDocuments = await profileAsync("detect:new-remote", () =>
				this.detectNewRemoteDocuments(
					snapshot,
					excludePaths,
					deferRemoteContent,
					onRemoteProgress
				)
			)
			changes.push(...newRemoteDocuments)
		} else {
			const remoteChanges = await profileAsync("detect:remote-walk", () =>
				this.detectRemoteTreeWalk(
					snapshot,
					excludePaths,
					freshPaths,
					deferRemoteContent,
					onRemoteProgress
				)
			)
			changes.push(...remoteChanges)
		}

		return changes
	}

	/**
	 * Detect changes in local filesystem compared to snapshot
	 */
	private async detectLocalChanges(
		snapshot: SyncSnapshot,
		currentFiles: Map<string, {content: string | Uint8Array; type: FileType}>,
		freshPaths?: Set<string>
	): Promise<DetectedChange[]> {
		const changes: DetectedChange[] = []

		// Check for new and modified files in parallel for better performance
		await Promise.all(
			Array.from(currentFiles.entries()).map(
				async ([relativePath, fileInfo]) => {
					// Worker-pushed this run; see detectChanges docs.
					if (freshPaths?.has(relativePath)) return

					const snapshotEntry = snapshot.files.get(relativePath)

					if (!snapshotEntry) {
						// New file
						changes.push({
							path: relativePath,
							changeType: ChangeType.LOCAL_ONLY,
							fileType: fileInfo.type,
							localContent: fileInfo.content,
							remoteContent: null,
						})
					} else if (this.isArtifactPath(relativePath)) {
						// Artifact files are always replaced wholesale (RawString).
						// Skip remote doc content reads — compare local hash against
						// stored hash to detect local changes, and check heads for remote.
						const localHash = contentHash(fileInfo.content)
						let localChanged: boolean
						if (snapshotEntry.contentHash) {
							localChanged = localHash !== snapshotEntry.contentHash
						} else {
							// No stored hash (snapshot written by an older version or a
							// code path that missed it). Do NOT assume changed: a phantom
							// local edit replaces the artifact doc wholesale and churns
							// the directory entries, which CRDT-merges into duplicated /
							// resurrected entries on peers. Fall back to one remote
							// content read, then backfill the hash so this is one-time.
							const remoteContent = await this.getCurrentRemoteContent(
								snapshotEntry.url
							)
							localChanged =
								remoteContent === null ||
								!isContentEqual(fileInfo.content, remoteContent)
							if (!localChanged) {
								snapshotEntry.contentHash = localHash
							}
						}

						const remoteHead = await this.getCurrentRemoteHead(
							snapshotEntry.url
						)
						const remoteChanged = !A.equals(remoteHead, snapshotEntry.head)

						if (localChanged || remoteChanged) {
							changes.push({
								path: relativePath,
								changeType:
									localChanged && remoteChanged
										? ChangeType.BOTH_CHANGED
										: localChanged
											? ChangeType.LOCAL_ONLY
											: ChangeType.REMOTE_ONLY,
								fileType: fileInfo.type,
								localContent: fileInfo.content,
								remoteContent: null,
								localHead: snapshotEntry.head,
								remoteHead,
							})
						}
					} else {
						// Check if content changed
						const lastKnownContent = await this.getContentAtHead(
							snapshotEntry.url,
							snapshotEntry.head
						)

						const contentChanged = !isContentEqual(
							fileInfo.content,
							lastKnownContent
						)

						if (contentChanged) {
							// Check remote state too
							const currentRemoteContent = await this.getCurrentRemoteContent(
								snapshotEntry.url
							)

							const remoteChanged = !isContentEqual(
								lastKnownContent,
								currentRemoteContent
							)

							const changeType = remoteChanged
								? ChangeType.BOTH_CHANGED
								: ChangeType.LOCAL_ONLY

							const remoteHead = await this.getCurrentRemoteHead(
								snapshotEntry.url
							)

							changes.push({
								path: relativePath,
								changeType,
								fileType: fileInfo.type,
								localContent: fileInfo.content,
								remoteContent: currentRemoteContent,
								localHead: snapshotEntry.head,
								remoteHead,
							})
						}
					}
				}
			)
		)

		// Check for deleted files in parallel
		await Promise.all(
			Array.from(snapshot.files.entries())
				.filter(([relativePath]) => !currentFiles.has(relativePath))
				.map(async ([relativePath, snapshotEntry]) => {
					if (this.isArtifactPath(relativePath)) {
						// Artifact deletion: skip remote content read
						const remoteHead = await this.getCurrentRemoteHead(
							snapshotEntry.url
						)
						const remoteChanged = !A.equals(remoteHead, snapshotEntry.head)

						changes.push({
							path: relativePath,
							changeType: remoteChanged
								? ChangeType.BOTH_CHANGED
								: ChangeType.LOCAL_ONLY,
							fileType: FileType.TEXT,
							localContent: null,
							remoteContent: null,
							localHead: snapshotEntry.head,
							remoteHead,
						})
						return
					}

					// File was deleted locally
					const currentRemoteContent = await this.getCurrentRemoteContent(
						snapshotEntry.url
					)
					const lastKnownContent = await this.getContentAtHead(
						snapshotEntry.url,
						snapshotEntry.head
					)

					const remoteChanged = !isContentEqual(
						lastKnownContent,
						currentRemoteContent
					)

					const changeType = remoteChanged
						? ChangeType.BOTH_CHANGED
						: ChangeType.LOCAL_ONLY

					changes.push({
						path: relativePath,
						changeType,
						fileType: FileType.TEXT, // Will be determined from document
						localContent: null,
						remoteContent: currentRemoteContent,
						localHead: snapshotEntry.head,
						remoteHead: await this.getCurrentRemoteHead(snapshotEntry.url),
					})
				})
		)

		return changes
	}

	/**
	 * Incremental remote-change detection: one tree walk that visits each
	 * directory exactly once.
	 *
	 * It does not prune unchanged subtrees on snapshot directory heads:
	 * `repo.find` is what makes Subduction sync a doc, so a pruned subtree
	 * would be read from a stale cache and its changes missed. (See CLAUDE.md
	 * for why head-based pruning is unsound here.)
	 */
	async detectRemoteTreeWalk(
		snapshot: SyncSnapshot,
		excludePaths?: Set<string>,
		freshPaths?: Set<string>,
		deferRemoteContent?: boolean,
		onProgress?: (discovered: number) => void
	): Promise<DetectedChange[]> {
		const changes: DetectedChange[] = []
		if (!snapshot.rootDirectoryUrl) return changes

		// Index the snapshot's direct children by parent directory path so a
		// changed directory can name which tracked children vanished remotely
		// without a global scan.
		const childFiles = new Map<string, Set<string>>()
		const childDirs = new Map<string, Set<string>>()
		const indexChild = (
			map: Map<string, Set<string>>,
			fullPath: string
		): void => {
			const slash = fullPath.lastIndexOf("/")
			const dir = slash === -1 ? "" : fullPath.slice(0, slash)
			const name = slash === -1 ? fullPath : fullPath.slice(slash + 1)
			let set = map.get(dir)
			if (!set) {
				set = new Set()
				map.set(dir, set)
			}
			set.add(name)
		}
		for (const p of snapshot.files.keys()) indexChild(childFiles, p)
		for (const p of snapshot.directories.keys()) {
			if (p !== "") indexChild(childDirs, p)
		}

		await this.walkRemoteDir(snapshot.rootDirectoryUrl, "", {
			snapshot,
			changes,
			childFiles,
			childDirs,
			excludePaths,
			freshPaths,
			deferRemoteContent,
			onProgress,
			maybeYield: makeYielder(),
		})
		return changes
	}

	/**
	 * One directory of the remote walk: classify present entries, report
	 * deletions, then recurse. Fetching each directory (`repo.find`) is also
	 * what drives Subduction to sync it.
	 */
	private async walkRemoteDir(
		directoryUrl: AutomergeUrl,
		dirPath: string,
		ctx: RemoteWalkContext
	): Promise<void> {
		const plainUrl = getPlainUrl(directoryUrl)
		const result = await this.findDocument<DirectoryDocument>(plainUrl)
		if (!result) return
		const dirDoc = result.doc

		const remoteFileNames = new Set<string>()
		const remoteDirNames = new Set<string>()
		for (const entry of dirDoc.docs) {
			if (entry.type === "file") remoteFileNames.add(entry.name)
			else if (entry.type === "folder") remoteDirNames.add(entry.name)
		}

		// Remote deletions: tracked children of this directory no longer
		// listed remotely (report only where the local file still exists).
		for (const name of ctx.childFiles.get(dirPath) ?? []) {
			if (remoteFileNames.has(name)) continue
			const filePath = dirPath ? `${dirPath}/${name}` : name
			if (ctx.excludePaths?.has(filePath)) continue
			if (ctx.freshPaths?.has(filePath)) continue
			const snapshotEntry = ctx.snapshot.files.get(filePath)
			if (!snapshotEntry) continue
			await this.reportRemoteDeletion(filePath, snapshotEntry, ctx)
		}
		for (const name of ctx.childDirs.get(dirPath) ?? []) {
			if (remoteDirNames.has(name)) continue
			// Whole subdirectory gone remotely — every tracked file under it
			// is a deletion.
			const subPath = dirPath ? `${dirPath}/${name}` : name
			const prefix = `${subPath}/`
			for (const [filePath, snapshotEntry] of ctx.snapshot.files) {
				if (filePath !== subPath && !filePath.startsWith(prefix)) continue
				if (ctx.excludePaths?.has(filePath)) continue
				if (ctx.freshPaths?.has(filePath)) continue
				await this.reportRemoteDeletion(filePath, snapshotEntry, ctx)
			}
		}

		// Present entries: recurse into folders, classify files.
		await mapWithConcurrency(dirDoc.docs, IO_CONCURRENCY, async entry => {
			const entryPath = dirPath ? `${dirPath}/${entry.name}` : entry.name

			if (entry.type === "folder") {
				await this.walkRemoteDir(entry.url, entryPath, ctx)
				return
			}
			if (entry.type !== "file") return
			if (ctx.excludePaths?.has(entryPath)) return
			if (ctx.freshPaths?.has(entryPath)) return

			const snapshotEntry = ctx.snapshot.files.get(entryPath)
			const change = snapshotEntry
				? await this.classifyTrackedRemoteFile(
						entryPath,
						snapshotEntry,
						entry.url
					)
				: await this.classifyNewRemoteFile(
						entryPath,
						entry.url,
						ctx.deferRemoteContent,
						ctx.onProgress,
						ctx.maybeYield
					)
			if (change) ctx.changes.push(change)
		})
	}

	/**
	 * Report a tracked file that vanished from its remote directory listing.
	 * Only a still-present local file is a remote deletion; a
	 * locally-deleted file is detectLocalChanges' job.
	 */
	private async reportRemoteDeletion(
		filePath: string,
		snapshotEntry: SnapshotFileEntry,
		ctx: RemoteWalkContext
	): Promise<void> {
		const localContent = await this.getLocalContent(filePath)
		if (localContent === null) return
		ctx.changes.push({
			path: filePath,
			changeType: ChangeType.REMOTE_ONLY,
			fileType: FileType.TEXT,
			localContent,
			remoteContent: null, // deleted remotely
			localHead: snapshotEntry.head,
			remoteHead: snapshotEntry.head,
		})
	}

	/**
	 * Classify a remote file that IS tracked in the snapshot (same path).
	 * Returns a change if its remote document moved (head differs, or the
	 * directory now points at a replacement URL), else null.
	 */
	private async classifyTrackedRemoteFile(
		entryPath: string,
		snapshotEntry: SnapshotFileEntry,
		remoteEntryUrl: AutomergeUrl
	): Promise<DetectedChange | null> {
		// A peer can replace a document entirely (new URL) rather than
		// mutating it: artifact replacement, legacy-immutable-string fix, or
		// recreateFailedDocuments. The old snapshot URL is then orphaned —
		// read from the new one.
		const urlReplaced =
			getPlainUrl(remoteEntryUrl) !== getPlainUrl(snapshotEntry.url)
		const remoteUrl = urlReplaced ? remoteEntryUrl : snapshotEntry.url

		const currentRemoteHead = await this.getCurrentRemoteHead(remoteUrl)

		if (!urlReplaced && A.equals(currentRemoteHead, snapshotEntry.head)) {
			// Unchanged — the common case inside a changed directory.
			return null
		}

		if (this.isArtifactPath(entryPath)) {
			// Artifacts are replaced wholesale (RawString), never diffed — so
			// skip getContentAtHead. The pull still needs the new bytes:
			// applyRemoteChangeToLocal treats remoteContent === null as a
			// deletion, so a null read (doc not materialized) is skipped here
			// rather than emitted, which would wrongly delete the file.
			// Genuine deletions come from the directory-listing scan.
			const localContent = await this.getLocalContent(entryPath)
			const remoteContent = await this.getCurrentRemoteContent(remoteUrl)
			if (remoteContent === null) return null
			return {
				path: entryPath,
				changeType:
					localContent !== null
						? ChangeType.BOTH_CHANGED
						: ChangeType.REMOTE_ONLY,
				fileType: await this.getFileTypeFromContent(remoteContent),
				localContent,
				remoteContent,
				localHead: snapshotEntry.head,
				remoteHead: currentRemoteHead,
				...(urlReplaced ? {remoteUrl: remoteEntryUrl} : {}),
			}
		}

		const currentRemoteContent = await this.getCurrentRemoteContent(remoteUrl)
		const localContent = await this.getLocalContent(entryPath)
		const lastKnownContent = urlReplaced
			? null // can't diff against the old doc when the URL changed
			: await this.getContentAtHead(snapshotEntry.url, snapshotEntry.head)

		const localChanged =
			localContent && lastKnownContent
				? !isContentEqual(localContent, lastKnownContent)
				: localContent !== null

		return {
			path: entryPath,
			changeType: localChanged
				? ChangeType.BOTH_CHANGED
				: ChangeType.REMOTE_ONLY,
			fileType: await this.getFileTypeFromContent(currentRemoteContent),
			localContent,
			remoteContent: currentRemoteContent,
			localHead: snapshotEntry.head,
			remoteHead: currentRemoteHead,
			...(urlReplaced ? {remoteUrl: remoteEntryUrl} : {}),
		}
	}

	/**
	 * Classify a remote file NOT tracked in the snapshot (new to us),
	 * including shard-pull deferral for the clean (no local copy) case.
	 */
	private async classifyNewRemoteFile(
		entryPath: string,
		entryUrl: AutomergeUrl,
		deferRemoteContent: boolean | undefined,
		onProgress: ((discovered: number) => void) | undefined,
		maybeYield: (() => Promise<void>) | undefined
	): Promise<DetectedChange | null> {
		const localContent = await this.getLocalContent(entryPath)

		// Deferred fetch (shard mode): emit a URL-only change for a shard-pull
		// worker. Only the clean case (no local copy) is deferrable —
		// coexistence needs content here to compare.
		if (deferRemoteContent && localContent === null) {
			onProgress?.(1)
			return {
				path: entryPath,
				changeType: ChangeType.REMOTE_ONLY,
				fileType: FileType.TEXT, // resolved by the worker
				localContent: null,
				remoteContent: null,
				remoteUrl: entryUrl,
				deferredFetch: true,
			}
		}

		const {content: remoteContent, head: remoteHead} =
			await this.getCurrentRemoteContentAndHead(entryUrl)
		onProgress?.(1)
		await maybeYield?.()

		if (localContent != null && remoteContent == null) {
			return {
				path: entryPath,
				changeType: ChangeType.BOTH_CHANGED,
				fileType: await this.getFileTypeFromContent(remoteContent),
				localContent,
				remoteContent,
				remoteHead,
			}
		} else if (localContent !== null && remoteContent === null) {
			return {
				path: entryPath,
				changeType: ChangeType.LOCAL_ONLY,
				fileType: await this.getFileTypeFromContent(localContent),
				localContent,
				remoteContent: null,
			}
		} else if (localContent === null && remoteContent !== null) {
			return {
				path: entryPath,
				changeType: ChangeType.REMOTE_ONLY,
				fileType: await this.getFileTypeFromContent(remoteContent),
				localContent: null,
				remoteContent,
				remoteHead,
			}
		}

		// Neither local nor remote content (ghost entry) — ignore.
		return null
	}

	/**
	 * Discover remote documents not in the snapshot. Used on clone, where the
	 * local snapshot is empty.
	 */
	private async detectNewRemoteDocuments(
		snapshot: SyncSnapshot,
		excludePaths?: Set<string>,
		deferRemoteContent?: boolean,
		onProgress?: (discovered: number) => void
	): Promise<DetectedChange[]> {
		const changes: DetectedChange[] = []

		// If no root directory URL, nothing to discover
		if (!snapshot.rootDirectoryUrl) {
			return changes
		}

		try {
			// One time-budgeted yielder for the whole walk: lets the event
			// loop run macrotasks (clack's spinner repaint, the Subduction
			// socket) periodically instead of being starved across a wide
			// concurrent download.
			const maybeYield = makeYielder()
			// Recursively traverse the directory hierarchy
			await this.discoverRemoteDocumentsRecursive(
				snapshot.rootDirectoryUrl,
				"",
				snapshot,
				changes,
				excludePaths,
				deferRemoteContent,
				onProgress,
				maybeYield
			)
		} catch (error) {
			out.taskLine(`Failed to discover remote documents: ${error}`, true)
		}

		return changes
	}

	/**
	 * Walk the remote directory tree and call `onFile(relPath, url)` for
	 * every remote file as it's discovered, without materializing any file
	 * content. Used by the streaming clone path so the download pool can
	 * start fetching files while the walk is still in progress.
	 *
	 * Only meaningful on a fresh/empty snapshot (clone): with a populated
	 * snapshot the discovery would also need content comparisons.
	 */
	async streamRemoteFiles(
		snapshot: SyncSnapshot,
		onFile: (relPath: string, url: AutomergeUrl) => void,
		onProgress?: (discovered: number) => void
	): Promise<void> {
		if (!snapshot.rootDirectoryUrl) return
		const discarded: DetectedChange[] = []
		const maybeYield = makeYielder()
		await this.discoverRemoteDocumentsRecursive(
			snapshot.rootDirectoryUrl,
			"",
			snapshot,
			discarded,
			undefined,
			true, // defer (emit URL-only, no content fetch)
			onProgress,
			maybeYield,
			onFile
		)
	}

	/**
	 * Recursively discover remote documents in directory hierarchy
	 */
	private async discoverRemoteDocumentsRecursive(
		directoryUrl: AutomergeUrl,
		currentPath: string,
		snapshot: SyncSnapshot,
		changes: DetectedChange[],
		excludePaths?: Set<string>,
		deferRemoteContent?: boolean,
		onProgress?: (discovered: number) => void,
		maybeYield?: () => Promise<void>,
		onFile?: (relPath: string, url: AutomergeUrl) => void
	): Promise<void> {
		try {
			// Find and wait for document to be available (retries on "unavailable")
			const plainUrl = getPlainUrl(directoryUrl)
			const result = await this.findDocument<DirectoryDocument>(plainUrl)

			if (!result) {
				return
			}
			const dirDoc = result.doc

			// Process entries concurrently (bounded). The walk is the clone
			// download — each file/dir entry is a `repo.find` round-trip, so
			// serial processing makes a 1000-file clone 1000 sequential
			// fetches. Subdirectory recursion fans out the same way (mirrors
			// network-sync's collectHeadsRecursive). Pushes to the shared
			// `changes` array are safe under single-threaded JS.
			await mapWithConcurrency(
				dirDoc.docs,
				IO_CONCURRENCY,
				async entry => {
					const entryPath = currentPath
						? `${currentPath}/${entry.name}`
						: entry.name

					if (entry.type === "folder") {
						await this.discoverRemoteDocumentsRecursive(
							entry.url,
							entryPath,
							snapshot,
							changes,
							excludePaths,
							deferRemoteContent,
							onProgress,
							maybeYield,
							onFile
						)
						return
					}

					if (entry.type !== "file") return

					// Skip files deliberately deleted during this sync cycle
					if (excludePaths?.has(entryPath)) {
						debug(`skipping deleted path during re-detection: ${entryPath}`)
						return
					}

					const existingEntry = snapshot.files.get(entryPath)

					if (!existingEntry) {
						// Remote file not in our snapshot
						const localContent = await this.getLocalContent(entryPath)

						// Deferred fetch (shard mode): emit a URL-only change for
						// a shard-pull worker. Only the clean case (no local
						// copy) is deferrable — coexistence needs content here
						// to compare.
						if (deferRemoteContent && localContent === null) {
							changes.push({
								path: entryPath,
								changeType: ChangeType.REMOTE_ONLY,
								fileType: FileType.TEXT, // resolved by the worker
								localContent: null,
								remoteContent: null,
								remoteUrl: entry.url,
								deferredFetch: true,
							})
							onProgress?.(1)
							// Streaming clone: hand the file to the download pool
							// the moment it's discovered (pipelines the walk with
							// the download).
							onFile?.(entryPath, entry.url)
							return
						}

						const {content: remoteContent, head: remoteHead} =
							await this.getCurrentRemoteContentAndHead(entry.url)
						onProgress?.(1)
						await maybeYield?.()

						if (localContent != null && remoteContent == null) {
							// File exists both locally and remotely but not in snapshot
							changes.push({
								path: entryPath,
								changeType: ChangeType.BOTH_CHANGED,
								fileType: await this.getFileTypeFromContent(remoteContent),
								localContent,
								remoteContent,
								remoteHead,
							})
						} else if (localContent !== null && remoteContent === null) {
							// File exists locally but not remotely (shouldn't happen in this flow)
							changes.push({
								path: entryPath,
								changeType: ChangeType.LOCAL_ONLY,
								fileType: await this.getFileTypeFromContent(localContent),
								localContent,
								remoteContent: null,
							})
						} else if (localContent === null && remoteContent !== null) {
							// File exists remotely but not locally — the clone case
							changes.push({
								path: entryPath,
								changeType: ChangeType.REMOTE_ONLY,
								fileType: await this.getFileTypeFromContent(remoteContent),
								localContent: null,
								remoteContent,
								remoteHead,
							})
						}
						// Else: neither local nor remote content (ghost entry) — ignore
					} else if (
						getPlainUrl(entry.url) !== getPlainUrl(existingEntry.url)
					) {
						// The directory points at a different URL than the
						// snapshot: a peer replaced the document wholesale rather
						// than mutating it (updateRemoteFile does this for artifact
						// paths, legacy immutable-string docs, and recreated
						// timed-out docs). The snapshot's old URL is orphaned, so
						// read content from the new one.
						const localContent = await this.getLocalContent(entryPath)
						const {content: remoteContent, head: remoteHead} =
							await this.getCurrentRemoteContentAndHead(entry.url)
						onProgress?.(1)
						await maybeYield?.()

						if (remoteContent !== null) {
							changes.push({
								path: entryPath,
								changeType:
									localContent !== null
										? ChangeType.BOTH_CHANGED
										: ChangeType.REMOTE_ONLY,
								fileType: await this.getFileTypeFromContent(remoteContent),
								localContent: localContent ?? null,
								remoteContent,
								remoteHead,
								remoteUrl: entry.url,
							})
						}
					}
				}
			)
		} catch (error) {
			out.taskLine(`Failed to process directory: ${error}`, true)
		}
	}

	/**
	 * Get current filesystem state as a map.
	 *
	 * Public so callers (sync) can scan once and pass the result to
	 * multiple `detectChanges` passes — re-scanning is expensive once
	 * `.pushwork/automerge` is populated (the glob enumerates every
	 * storage file before excluding it).
	 */
	async getCurrentFilesystemState(): Promise<
		Map<string, {content: string | Uint8Array; type: FileType}>
	> {
		const fileMap = new Map<
			string,
			{content: string | Uint8Array; type: FileType}
		>()

		try {
			const entries = await listDirectory(
				this.rootPath,
				true,
				this.excludePatterns
			)

			const fileEntries = entries.filter(
				entry => entry.type !== FileType.DIRECTORY
			)

			// Bounded so a huge tree doesn't read every file into memory at
			// once (content is buffered until detection finishes).
			await mapWithConcurrency(fileEntries, IO_CONCURRENCY, async entry => {
				const relativePath = getRelativePath(this.rootPath, entry.path)
				const content = await readFileContent(entry.path)

				fileMap.set(relativePath, {content, type: entry.type})
			})
		} catch (error) {
			out.taskLine(`Failed to scan filesystem: ${error}`, true)
			// Log more details about the error
			if (error instanceof Error) {
				out.taskLine(`Error details: ${error.message}`, true)
				if (error.stack) {
					out.taskLine(`Stack: ${error.stack}`, true)
				}
			}
		}

		return fileMap
	}

	/**
	 * Get local file content if it exists
	 */
	private async getLocalContent(
		relativePath: string
	): Promise<string | Uint8Array | null> {
		try {
			const fullPath = joinAndNormalizePath(this.rootPath, relativePath)
			return await readFileContent(fullPath)
		} catch {
			return null
		}
	}

	/**
	 * Get content from Automerge document at specific head
	 */
	private async getContentAtHead(
		url: AutomergeUrl,
		heads: UrlHeads
	): Promise<string | Uint8Array | null> {
		try {
			// Strip heads for current document state
			const plainUrl = getPlainUrl(url)
			const handle = await this.repo.find<FileDocument>(plainUrl)
			const doc = await handle.view(heads).doc()

			const content = (doc as FileDocument | undefined)?.content
			return readDocContent(content)
		} catch {
			return null
		}
	}

	/**
	 * Get current content from Automerge document
	 */
	private async getCurrentRemoteContent(
		url: AutomergeUrl
	): Promise<string | Uint8Array | null> {
		try {
			const plainUrl = getPlainUrl(url)
			const result = await this.findDocument<FileDocument>(plainUrl)

			if (!result) return null

			const content = result.doc.content
			return readDocContent(content)
		} catch (error) {
			out.taskLine(`Failed to get remote content: ${error}`, true)
			return null
		}
	}

	/**
	 * Find and wait for a document to be available, with retry logic.
	 * repo.find() rejects with "unavailable" if the server doesn't have the
	 * document yet, and doc() throws if the handle isn't ready. We retry
	 * both with backoff since the document may just not have propagated yet.
	 */
	private async findDocument<T>(
		url: AutomergeUrl,
		options: {maxRetries?: number; retryDelayMs?: number} = {}
	): Promise<{handle: DocHandle<T>; doc: T} | undefined> {
		const {maxRetries = 5, retryDelayMs = 500} = options

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const handle = await this.repo.find<T>(url)
				const doc = handle.doc()
				return {handle, doc}
			} catch {
				// Document may be unavailable — retry after a delay
				if (attempt < maxRetries - 1) {
					await new Promise(r => setTimeout(r, retryDelayMs * (attempt + 1)))
				}
			}
		}

		return undefined
	}

	/**
	 * Get current head of Automerge document
	 */
	private async getCurrentRemoteHead(url: AutomergeUrl): Promise<UrlHeads> {
		try {
			const plainUrl = getPlainUrl(url)
			const result = await this.findDocument<FileDocument>(plainUrl, {
				maxRetries: 3,
				retryDelayMs: 200,
			})
			if (!result) return [] as unknown as UrlHeads
			return result.handle.heads()
		} catch {
			return [] as unknown as UrlHeads
		}
	}

	/**
	 * Fetch a remote file's content AND heads in a SINGLE `repo.find`.
	 * The discovery walk needs both per file; calling getCurrentRemoteContent
	 * then getCurrentRemoteHead would fetch the same document twice.
	 */
	private async getCurrentRemoteContentAndHead(
		url: AutomergeUrl
	): Promise<{content: string | Uint8Array | null; head: UrlHeads}> {
		const empty = {content: null, head: [] as unknown as UrlHeads}
		try {
			const plainUrl = getPlainUrl(url)
			const result = await profileAsync("discover:find", () =>
				this.findDocument<FileDocument>(plainUrl)
			)
			if (!result) return empty
			const content = await profileAsync("discover:materialize", async () =>
				readDocContent(result.doc.content)
			)
			count("discover:docs")
			return {
				content,
				head: result.handle.heads(),
			}
		} catch (error) {
			out.taskLine(`Failed to get remote document: ${error}`, true)
			return empty
		}
	}

	/**
	 * Determine file type from content
	 */
	private async getFileTypeFromContent(
		content: string | Uint8Array | null
	): Promise<FileType> {
		if (content == null) return FileType.TEXT

		if (content instanceof Uint8Array) {
			return FileType.BINARY
		} else {
			return FileType.TEXT
		}
	}

	/**
	 * Classify change type for a path
	 */
	async classifyChange(
		relativePath: string,
		snapshot: SyncSnapshot
	): Promise<ChangeType> {
		const snapshotEntry = snapshot.files.get(relativePath)
		const localContent = await this.getLocalContent(relativePath)

		if (!snapshotEntry) {
			// New file
			return ChangeType.LOCAL_ONLY
		}

		const lastKnownContent = await this.getContentAtHead(
			snapshotEntry.url,
			snapshotEntry.head
		)
		const currentRemoteContent = await this.getCurrentRemoteContent(
			snapshotEntry.url
		)

		const localChanged = localContent
			? !isContentEqual(localContent, lastKnownContent)
			: true
		const remoteChanged = !isContentEqual(
			lastKnownContent,
			currentRemoteContent
		)

		if (!localChanged && !remoteChanged) {
			return ChangeType.NO_CHANGE
		} else if (localChanged && !remoteChanged) {
			return ChangeType.LOCAL_ONLY
		} else if (!localChanged && remoteChanged) {
			return ChangeType.REMOTE_ONLY
		} else {
			return ChangeType.BOTH_CHANGED
		}
	}
}
