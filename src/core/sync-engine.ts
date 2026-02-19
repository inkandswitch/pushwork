import {
	AutomergeUrl,
	Repo,
	DocHandle,
	UrlHeads,
	parseAutomergeUrl,
	stringifyAutomergeUrl,
} from "@automerge/automerge-repo"
import * as A from "@automerge/automerge"
import {
	SyncSnapshot,
	SyncResult,
	FileDocument,
	DirectoryDocument,
	ChangeType,
	FileType,
	MoveCandidate,
	DirectoryConfig,
	DetectedChange,
} from "../types"
import {
	writeFileContent,
	removePath,
	getFileExtension,
	getEnhancedMimeType,
	formatRelativePath,
	findFileInDirectoryHierarchy,
	joinAndNormalizePath,
	getPlainUrl,
	updateTextContent,
	readDocContent,
} from "../utils"
import {isContentEqual, contentHash} from "../utils/content"
import {waitForSync, waitForBidirectionalSync} from "../utils/network-sync"
import {SnapshotManager} from "./snapshot"
import {ChangeDetector} from "./change-detection"
import {MoveDetector} from "./move-detection"
import {out} from "../utils/output"
import * as path from "path"

const isDebug = !!process.env.DEBUG
function debug(...args: any[]) {
	if (isDebug) console.error("[pushwork:engine]", ...args)
}

/**
 * Apply a change to a document handle, using changeAt when heads are available
 * to branch from a known version, otherwise falling back to change.
 */
function changeWithOptionalHeads<T>(
	handle: DocHandle<T>,
	heads: UrlHeads | undefined,
	callback: A.ChangeFn<T>
): void {
	if (heads && heads.length > 0) {
		handle.changeAt(heads, callback)
	} else {
		handle.change(callback)
	}
}

/**
 * Sync configuration constants
 */
const BIDIRECTIONAL_SYNC_TIMEOUT_MS = 5000 // Timeout for bidirectional sync stability check

/**
 * Bidirectional sync engine implementing two-phase sync
 */
export class SyncEngine {
	private snapshotManager: SnapshotManager
	private changeDetector: ChangeDetector
	private moveDetector: MoveDetector
	// Map from path to handle for leaf-first sync ordering
	// Path depth determines sync order (deepest first)
	private handlesByPath: Map<string, DocHandle<unknown>> = new Map()
	private config: DirectoryConfig

	constructor(
		private repo: Repo,
		private rootPath: string,
		config: DirectoryConfig
	) {
		this.config = config
		this.snapshotManager = new SnapshotManager(rootPath)
		this.changeDetector = new ChangeDetector(
			repo,
			rootPath,
			config.exclude_patterns,
			config.artifact_directories || []
		)
		this.moveDetector = new MoveDetector(config.sync.move_detection_threshold)
	}

	/**
	 * Determine if content should be treated as text for Automerge text operations
	 * Note: This method checks the runtime type. File type detection happens
	 * during reading with isEnhancedTextFile() which now has better dev file support.
	 */
	private isTextContent(content: string | Uint8Array): boolean {
		// Simply check the actual type of the content
		return typeof content === "string"
	}

	/**
	 * Get a versioned URL from a handle (includes current heads).
	 * This ensures clients can fetch the exact version of the document.
	 */
	private getVersionedUrl(handle: DocHandle<unknown>): AutomergeUrl {
		const {documentId} = parseAutomergeUrl(handle.url)
		const heads = handle.heads()
		return stringifyAutomergeUrl({documentId, heads})
	}

	/**
	 * Determine if a file path is inside an artifact directory.
	 * Artifact files are stored as immutable strings (RawString) and
	 * referenced with versioned URLs in directory entries.
	 */
	private isArtifactPath(filePath: string): boolean {
		const artifactDirs = this.config.artifact_directories || []
		return artifactDirs.some(
			dir => filePath === dir || filePath.startsWith(dir + "/")
		)
	}

	/**
	 * Get the appropriate URL for a directory entry.
	 * Artifact paths get versioned URLs (with heads) for exact version fetching.
	 * Non-artifact paths get plain URLs for collaborative editing.
	 */
	private getEntryUrl(handle: DocHandle<unknown>, filePath: string): AutomergeUrl {
		if (this.isArtifactPath(filePath)) {
			return this.getVersionedUrl(handle)
		}
		return getPlainUrl(handle.url)
	}

	/**
	 * Set the root directory URL in the snapshot
	 */
	async setRootDirectoryUrl(url: AutomergeUrl): Promise<void> {
		let snapshot = await this.snapshotManager.load()
		if (!snapshot) {
			snapshot = this.snapshotManager.createEmpty()
		}
		snapshot.rootDirectoryUrl = url
		await this.snapshotManager.save(snapshot)
	}

	/**
	 * Reset the snapshot, clearing all tracked files and directories.
	 * Preserves the rootDirectoryUrl so sync can still operate.
	 * Used by --force to re-sync every file.
	 */
	async resetSnapshot(): Promise<void> {
		let snapshot = await this.snapshotManager.load()
		if (!snapshot) return
		this.snapshotManager.clear(snapshot)
		await this.snapshotManager.save(snapshot)
	}

	/**
	 * Nuclear reset: clear the snapshot AND wipe the root directory document's
	 * entries so that every file and subdirectory gets brand-new Automerge
	 * documents. The root directory document itself is preserved.
	 */
	async nuclearReset(): Promise<void> {
		let snapshot = await this.snapshotManager.load()
		if (!snapshot) return

		// Clear the root directory document's entries
		if (snapshot.rootDirectoryUrl) {
			const rootHandle = await this.repo.find<DirectoryDocument>(
				getPlainUrl(snapshot.rootDirectoryUrl)
			)
			rootHandle.change((doc: DirectoryDocument) => {
				doc.docs.splice(0, doc.docs.length)
			})
		}

		// Clear all tracked files and directories from snapshot
		this.snapshotManager.clear(snapshot)
		await this.snapshotManager.save(snapshot)
	}

	/**
	 * Commit local changes only (no network sync)
	 */
	async commitLocal(): Promise<SyncResult> {
		const result: SyncResult = {
			success: false,
			filesChanged: 0,
			directoriesChanged: 0,
			errors: [],
			warnings: [],
		}

		try {
			// Load current snapshot
			let snapshot = await this.snapshotManager.load()
			if (!snapshot) {
				snapshot = this.snapshotManager.createEmpty()
			}

			// Detect all changes
			const changes = await this.changeDetector.detectChanges(snapshot)

			// Detect moves
			const {moves, remainingChanges} = await this.moveDetector.detectMoves(
				changes,
				snapshot
			)

			// Apply local changes only (no network sync)
			const commitResult = await this.pushLocalChanges(
				remainingChanges,
				moves,
				snapshot
			)

			result.filesChanged += commitResult.filesChanged
			result.directoriesChanged += commitResult.directoriesChanged
			result.errors.push(...commitResult.errors)
			result.warnings.push(...commitResult.warnings)

			// Touch root directory if any changes were made
			const hasChanges =
				result.filesChanged > 0 || result.directoriesChanged > 0
			if (hasChanges) {
				await this.touchRootDirectory(snapshot)
			}

			// Save updated snapshot
			await this.snapshotManager.save(snapshot)

			result.success = result.errors.length === 0

			return result
		} catch (error) {
			result.errors.push({
				path: this.rootPath,
				operation: "commitLocal",
				error: error instanceof Error ? error : new Error(String(error)),
				recoverable: true,
			})
			result.success = false
			return result
		}
	}

	/**
	 * Recreate documents that failed to sync. Creates new Automerge documents
	 * with the same content and updates all references (snapshot, parent directory).
	 * Returns new handles that should be retried for sync.
	 */
	private async recreateFailedDocuments(
		failedHandles: DocHandle<unknown>[],
		snapshot: SyncSnapshot
	): Promise<DocHandle<unknown>[]> {
		const failedUrls = new Set(failedHandles.map(h => getPlainUrl(h.url)))
		const newHandles: DocHandle<unknown>[] = []

		// Find which paths correspond to the failed handles
		for (const [filePath, entry] of snapshot.files.entries()) {
			const plainUrl = getPlainUrl(entry.url)
			if (!failedUrls.has(plainUrl)) continue

			debug(`recreate: recreating document for ${filePath} (${plainUrl.slice(0, 20)}...)`)
			out.taskLine(`Recreating document for ${filePath}`)

			try {
				// Read the current content from the old handle
				const oldHandle = await this.repo.find<FileDocument>(plainUrl)
				const doc = await oldHandle.doc()
				if (!doc) {
					debug(`recreate: could not read doc for ${filePath}, skipping`)
					continue
				}

				const content = readDocContent(doc.content)
				if (content === null) {
					debug(`recreate: null content for ${filePath}, skipping`)
					continue
				}

				// Create a fresh document
				const fakeChange: DetectedChange = {
					path: filePath,
					changeType: ChangeType.LOCAL_ONLY,
					fileType: this.isTextContent(content) ? FileType.TEXT : FileType.BINARY,
					localContent: content,
					remoteContent: null,
				}
				const newHandle = await this.createRemoteFile(fakeChange)
				if (!newHandle) continue

				const entryUrl = this.getEntryUrl(newHandle, filePath)

				// Update snapshot entry
				this.snapshotManager.updateFileEntry(snapshot, filePath, {
					...entry,
					url: entryUrl,
					head: newHandle.heads(),
					...(this.isArtifactPath(filePath) ? {contentHash: contentHash(content)} : {}),
				})

				// Update parent directory entry to point to new document
				const pathParts = filePath.split("/")
				const fileName = pathParts.pop() || ""
				const dirPath = pathParts.join("/")

				let dirUrl: AutomergeUrl
				if (!dirPath || dirPath === "") {
					dirUrl = snapshot.rootDirectoryUrl!
				} else {
					const dirEntry = snapshot.directories.get(dirPath)
					if (!dirEntry) continue
					dirUrl = dirEntry.url
				}

				const dirHandle = await this.repo.find<DirectoryDocument>(getPlainUrl(dirUrl))
				dirHandle.change((d: DirectoryDocument) => {
					const idx = d.docs.findIndex(
						e => e.name === fileName && e.type === "file"
					)
					if (idx !== -1) {
						d.docs[idx].url = entryUrl
					}
				})

				// Track new handles
				this.handlesByPath.set(filePath, newHandle)
				this.handlesByPath.set(dirPath, dirHandle)
				newHandles.push(newHandle)
				newHandles.push(dirHandle)

				debug(`recreate: created new doc for ${filePath} -> ${newHandle.url.slice(0, 20)}...`)
			} catch (error) {
				debug(`recreate: failed for ${filePath}: ${error}`)
				out.taskLine(`Failed to recreate ${filePath}: ${error}`, true)
			}
		}

		// Also check directory documents
		for (const [dirPath, entry] of snapshot.directories.entries()) {
			const plainUrl = getPlainUrl(entry.url)
			if (!failedUrls.has(plainUrl)) continue

			// Directory docs can't be easily recreated (they reference children).
			// Just log a warning — the child recreation above should handle most cases.
			debug(`recreate: directory ${dirPath || "(root)"} failed to sync, cannot recreate`)
			out.taskLine(`Warning: directory ${dirPath || "(root)"} failed to sync`, true)
		}

		return newHandles
	}

	/**
	 * Run full bidirectional sync
	 */
	async sync(): Promise<SyncResult> {
		const result: SyncResult = {
			success: false,
			filesChanged: 0,
			directoriesChanged: 0,
			errors: [],
			warnings: [],
			timings: {},
		}

		// Reset tracked handles for sync
		this.handlesByPath = new Map()

		try {
			// Load current snapshot
			const snapshot =
				(await this.snapshotManager.load()) ||
				this.snapshotManager.createEmpty()

			debug(`sync: rootDirectoryUrl=${snapshot.rootDirectoryUrl?.slice(0, 30)}..., files=${snapshot.files.size}, dirs=${snapshot.directories.size}`)

			// Wait for initial sync to receive any pending remote changes
			if (this.config.sync_enabled && snapshot.rootDirectoryUrl) {
				debug("sync: waiting for root document to be ready")
				out.update("Waiting for root document from server")

				// Wait for the root document to be fetched from the network.
				// repo.find() rejects with "unavailable" if the server doesn't
				// have the document yet, so we retry with backoff.
				// This is critical for clone scenarios.
				const plainRootUrl = getPlainUrl(snapshot.rootDirectoryUrl)
				const maxAttempts = 6
				for (let attempt = 1; attempt <= maxAttempts; attempt++) {
					try {
						const rootHandle = await this.repo.find<DirectoryDocument>(plainRootUrl)
						rootHandle.doc() // throws if not ready
						debug(`sync: root document ready (attempt ${attempt})`)
						break
					} catch (error) {
						const isUnavailable = String(error).includes("unavailable") || String(error).includes("not ready")
						if (isUnavailable && attempt < maxAttempts) {
							const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000)
							debug(`sync: root document not available (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`)
							out.update(`Waiting for root document (attempt ${attempt}/${maxAttempts})`)
							await new Promise(r => setTimeout(r, delay))
						} else {
							debug(`sync: root document unavailable after ${maxAttempts} attempts: ${error}`)
							out.taskLine(`Root document unavailable: ${error}`, true)
							break
						}
					}
				}

				debug("sync: waiting for initial bidirectional sync")
				out.update("Waiting for initial sync from server")
				try {
					await waitForBidirectionalSync(
						this.repo,
						snapshot.rootDirectoryUrl,
						this.config.sync_server_storage_id,
						{
							timeoutMs: 5000, // Increased timeout for initial sync
							pollIntervalMs: 100,
							stableChecksRequired: 3,
						}
					)
				} catch (error) {
					out.taskLine(`Initial sync: ${error}`, true)
				}
			}

			// Detect all changes
			debug("sync: detecting changes")
			out.update("Detecting local and remote changes")
			const changes = await this.changeDetector.detectChanges(snapshot)

			// Detect moves
			const {moves, remainingChanges} = await this.moveDetector.detectMoves(
				changes,
				snapshot
			)

			debug(`sync: detected ${changes.length} changes, ${moves.length} moves, ${remainingChanges.length} remaining`)

			// Phase 1: Push local changes to remote
			debug("sync: phase 1 - pushing local changes")
			const phase1Result = await this.pushLocalChanges(
				remainingChanges,
				moves,
				snapshot
			)

			result.filesChanged += phase1Result.filesChanged
			result.directoriesChanged += phase1Result.directoriesChanged
			result.errors.push(...phase1Result.errors)
			result.warnings.push(...phase1Result.warnings)

			debug(`sync: phase 1 complete - ${phase1Result.filesChanged} files, ${phase1Result.directoriesChanged} dirs changed`)

			// Wait for network sync (important for clone scenarios)
			if (this.config.sync_enabled) {
				try {
					// Ensure root directory handle is tracked for sync
					if (snapshot.rootDirectoryUrl) {
						const rootHandle =
							await this.repo.find<DirectoryDocument>(
								snapshot.rootDirectoryUrl
							)
						this.handlesByPath.set("", rootHandle)
					}

					// Single waitForSync with ALL tracked handles at once
					if (this.handlesByPath.size > 0) {
						const allHandles = Array.from(
							this.handlesByPath.values()
						)
						const handlePaths = Array.from(this.handlesByPath.keys())
						debug(`sync: waiting for ${allHandles.length} handles to sync to server: ${handlePaths.slice(0, 10).map(p => p || "(root)").join(", ")}${handlePaths.length > 10 ? ` ...and ${handlePaths.length - 10} more` : ""}`)
						out.update(`Uploading ${allHandles.length} documents to sync server`)
						const {failed} = await waitForSync(
							allHandles,
							this.config.sync_server_storage_id
						)

						// Recreate failed documents and retry once
						if (failed.length > 0) {
							debug(`sync: ${failed.length} documents failed, recreating`)
							out.update(`Recreating ${failed.length} failed documents`)
							const retryHandles = await this.recreateFailedDocuments(failed, snapshot)
							if (retryHandles.length > 0) {
								debug(`sync: retrying ${retryHandles.length} recreated handles`)
								out.update(`Retrying ${retryHandles.length} recreated documents`)
								const retry = await waitForSync(
									retryHandles,
									this.config.sync_server_storage_id
								)
								if (retry.failed.length > 0) {
									const msg = `${retry.failed.length} documents failed to sync to server after recreation`
									debug(`sync: ${msg}`)
									result.errors.push({
										path: "sync",
										operation: "upload",
										error: new Error(msg),
										recoverable: true,
									})
								}
							}
						}

						debug("sync: all handles synced to server")
					}

					// Wait for bidirectional sync to stabilize
					// Use tracked handles for post-push check (cheaper than full tree scan)
					const changedHandles = Array.from(this.handlesByPath.values())
					debug(`sync: waiting for bidirectional sync to stabilize (${changedHandles.length} tracked handles)`)
					out.update("Waiting for bidirectional sync to stabilize")
					await waitForBidirectionalSync(
						this.repo,
						snapshot.rootDirectoryUrl,
						this.config.sync_server_storage_id,
						{
							timeoutMs: BIDIRECTIONAL_SYNC_TIMEOUT_MS,
							pollIntervalMs: 100,
							stableChecksRequired: 3,
							handles: changedHandles.length > 0 ? changedHandles : undefined,
						}
					)
				} catch (error) {
					debug(`sync: network sync error: ${error}`)
					out.taskLine(`Network sync failed: ${error}`, true)
					result.errors.push({
						path: "sync",
						operation: "network-sync",
						error: error instanceof Error ? error : new Error(String(error)),
						recoverable: true,
					})
				}
			}

			// Re-detect changes after network sync for fresh state
			debug("sync: re-detecting changes after network sync")
			const freshChanges = await this.changeDetector.detectChanges(snapshot)
			const freshRemoteChanges = freshChanges.filter(
				c =>
					c.changeType === ChangeType.REMOTE_ONLY ||
					c.changeType === ChangeType.BOTH_CHANGED
			)

			debug(`sync: phase 2 - pulling ${freshRemoteChanges.length} remote changes`)
			if (freshRemoteChanges.length > 0) {
				out.update(`Pulling ${freshRemoteChanges.length} remote changes`)
			}
			// Phase 2: Pull remote changes to local using fresh detection
			const phase2Result = await this.pullRemoteChanges(
				freshRemoteChanges,
				snapshot
			)
			result.filesChanged += phase2Result.filesChanged
			result.directoriesChanged += phase2Result.directoriesChanged
			result.errors.push(...phase2Result.errors)
			result.warnings.push(...phase2Result.warnings)

			// Update snapshot heads after pulling remote changes
			for (const [filePath, snapshotEntry] of snapshot.files.entries()) {
				try {
					const handle = await this.repo.find(snapshotEntry.url)
					const currentHeads = handle.heads()
					if (!A.equals(currentHeads, snapshotEntry.head)) {
						// Update snapshot with current heads after pulling changes
						snapshot.files.set(filePath, {
							...snapshotEntry,
							head: currentHeads,
						})
					}
				} catch (error) {
					// Handle might not exist if file was deleted
				}
			}

			// Update directory document heads
			for (const [dirPath, snapshotEntry] of snapshot.directories.entries()) {
				try {
					const handle = await this.repo.find(snapshotEntry.url)
					const currentHeads = handle.heads()
					if (!A.equals(currentHeads, snapshotEntry.head)) {
						// Update snapshot with current heads after pulling changes
						snapshot.directories.set(dirPath, {
							...snapshotEntry,
							head: currentHeads,
						})
					}
				} catch (error) {
					// Handle might not exist if directory was deleted
				}
			}

			// Touch root directory if any changes were made during sync
			const hasChanges =
				result.filesChanged > 0 || result.directoriesChanged > 0
			if (hasChanges) {
				await this.touchRootDirectory(snapshot)
			}

			// Save updated snapshot if not dry run
			await this.snapshotManager.save(snapshot)

			result.success = result.errors.length === 0
			return result
		} catch (error) {
			result.errors.push({
				path: "sync",
				operation: "full-sync",
				error: error as Error,
				recoverable: false,
			})
			return result
		}
	}

	/**
	 * Phase 1: Push local changes to Automerge documents.
	 *
	 * Works depth-first: processes the deepest files first, creates/updates all
	 * file docs at each level, then batch-updates the parent directory document
	 * in a single change. Propagates subdirectory URL updates as we walk up
	 * toward the root. This eliminates the need for a separate URL update pass.
	 */
	private async pushLocalChanges(
		changes: DetectedChange[],
		moves: MoveCandidate[],
		snapshot: SyncSnapshot
	): Promise<SyncResult> {
		const result: SyncResult = {
			success: true,
			filesChanged: 0,
			directoriesChanged: 0,
			errors: [],
			warnings: [],
		}

		// Process moves first - all detected moves are applied
		if (moves.length > 0) {
			debug(`push: processing ${moves.length} moves`)
			out.update(`Processing ${moves.length} move${moves.length > 1 ? "s" : ""}`)
		}
		for (let i = 0; i < moves.length; i++) {
			const move = moves[i]
			try {
				debug(`push: move ${i + 1}/${moves.length}: ${move.fromPath} -> ${move.toPath}`)
				out.taskLine(`Moving ${move.fromPath} -> ${move.toPath}`)
				await this.applyMoveToRemote(move, snapshot)
				result.filesChanged++
			} catch (error) {
				debug(`push: move failed for ${move.fromPath}: ${error}`)
				result.errors.push({
					path: move.fromPath,
					operation: "move",
					error: error as Error,
					recoverable: true,
				})
			}
		}

		// Filter to local changes only
		const localChanges = changes.filter(
			c =>
				c.changeType === ChangeType.LOCAL_ONLY ||
				c.changeType === ChangeType.BOTH_CHANGED
		)

		if (localChanges.length === 0) {
			debug("push: no local changes to push")
			return result
		}

		const newFiles = localChanges.filter(c => !snapshot.files.has(c.path) && c.localContent !== null)
		const modifiedFiles = localChanges.filter(c => snapshot.files.has(c.path) && c.localContent !== null)
		const deletedFiles = localChanges.filter(c => c.localContent === null && snapshot.files.has(c.path))
		debug(`push: ${localChanges.length} local changes (${newFiles.length} new, ${modifiedFiles.length} modified, ${deletedFiles.length} deleted)`)
		out.update(`Pushing ${localChanges.length} local changes (${newFiles.length} new, ${modifiedFiles.length} modified, ${deletedFiles.length} deleted)`)

		// Group changes by parent directory path
		const changesByDir = new Map<string, DetectedChange[]>()
		for (const change of localChanges) {
			const pathParts = change.path.split("/")
			pathParts.pop() // remove filename
			const dirPath = pathParts.join("/")
			if (!changesByDir.has(dirPath)) {
				changesByDir.set(dirPath, [])
			}
			changesByDir.get(dirPath)!.push(change)
		}

		// Collect all directory paths that need processing:
		// directories with file changes + all ancestors up to root
		const allDirsToProcess = new Set<string>()
		for (const dirPath of changesByDir.keys()) {
			allDirsToProcess.add(dirPath)
			// Add ancestors so subdirectory URL updates propagate to root
			let current = dirPath
			while (current) {
				const parts = current.split("/")
				parts.pop()
				current = parts.join("/")
				allDirsToProcess.add(current)
			}
		}

		// Sort deepest-first
		const sortedDirPaths = Array.from(allDirsToProcess).sort((a, b) => {
			const depthA = a ? a.split("/").length : 0
			const depthB = b ? b.split("/").length : 0
			return depthB - depthA
		})

		debug(`push: processing ${sortedDirPaths.length} directories (deepest first)`)

		// Track which directories were modified (for subdirectory URL propagation)
		const modifiedDirs = new Set<string>()
		let filesProcessed = 0
		const totalFiles = localChanges.length

		for (const dirPath of sortedDirPaths) {
			const dirChanges = changesByDir.get(dirPath) || []
			const dirLabel = dirPath || "(root)"

			if (dirChanges.length > 0) {
				debug(`push: directory "${dirLabel}": ${dirChanges.length} file changes`)
			}

			// Ensure directory document exists
			if (snapshot.rootDirectoryUrl) {
				await this.ensureDirectoryDocument(snapshot, dirPath)
			}

			// Process all file changes in this directory
			const newEntries: {name: string; url: AutomergeUrl}[] = []
			const updatedEntries: {name: string; url: AutomergeUrl}[] = []
			const deletedNames: string[] = []

			for (const change of dirChanges) {
				const fileName = change.path.split("/").pop() || ""
				const snapshotEntry = snapshot.files.get(change.path)
				filesProcessed++

				try {
					if (change.localContent === null && snapshotEntry) {
						// Delete file
						debug(`push: [${filesProcessed}/${totalFiles}] delete ${change.path}`)
						out.update(`Pushing local changes [${filesProcessed}/${totalFiles}] deleting ${change.path}`)
						await this.deleteRemoteFile(
							snapshotEntry.url,
							snapshot,
							change.path
						)
						deletedNames.push(fileName)
						this.snapshotManager.removeFileEntry(snapshot, change.path)
						result.filesChanged++
					} else if (!snapshotEntry) {
						// New file
						debug(`push: [${filesProcessed}/${totalFiles}] create ${change.path} (${change.fileType})`)
						out.update(`Pushing local changes [${filesProcessed}/${totalFiles}] creating ${change.path}`)
						const handle = await this.createRemoteFile(change)
						if (handle) {
							const entryUrl = this.getEntryUrl(handle, change.path)
							newEntries.push({name: fileName, url: entryUrl})
							this.snapshotManager.updateFileEntry(
								snapshot,
								change.path,
								{
									path: joinAndNormalizePath(
										this.rootPath,
										change.path
									),
									url: entryUrl,
									head: handle.heads(),
									extension: getFileExtension(change.path),
									mimeType: getEnhancedMimeType(change.path),
									...(this.isArtifactPath(change.path) && change.localContent
										? {contentHash: contentHash(change.localContent)}
										: {}),
								}
							)
							result.filesChanged++
							debug(`push: created ${change.path} -> ${handle.url.slice(0, 20)}...`)
						}
					} else {
						// Update existing file
						const contentSize = typeof change.localContent === "string"
							? `${change.localContent!.length} chars`
							: `${(change.localContent as Uint8Array).length} bytes`
						debug(`push: [${filesProcessed}/${totalFiles}] update ${change.path} (${contentSize})`)
						out.update(`Pushing local changes [${filesProcessed}/${totalFiles}] updating ${change.path}`)
						await this.updateRemoteFile(
							snapshotEntry.url,
							change.localContent!,
							snapshot,
							change.path
						)
						// Get current entry URL (updateRemoteFile updates snapshot)
						const updatedFileEntry = snapshot.files.get(change.path)
						if (updatedFileEntry) {
							const fileHandle =
								await this.repo.find<FileDocument>(
									getPlainUrl(updatedFileEntry.url)
								)
							updatedEntries.push({
								name: fileName,
								url: this.getEntryUrl(fileHandle, change.path),
							})
						}
						result.filesChanged++
					}
				} catch (error) {
					debug(`push: error processing ${change.path}: ${error}`)
					out.taskLine(`Error pushing ${change.path}: ${error}`, true)
					result.errors.push({
						path: change.path,
						operation: "local-to-remote",
						error: error as Error,
						recoverable: true,
					})
				}
			}

			// Collect subdirectory URL updates for child dirs already processed
			const subdirUpdates: {name: string; url: AutomergeUrl}[] = []
			for (const modifiedDir of modifiedDirs) {
				// Check if modifiedDir is a direct child of dirPath
				const parts = modifiedDir.split("/")
				const childName = parts.pop() || ""
				const parentOfModified = parts.join("/")
				if (parentOfModified === dirPath) {
					const dirEntry = snapshot.directories.get(modifiedDir)
					if (dirEntry) {
						const childHandle =
							await this.repo.find<DirectoryDocument>(
								getPlainUrl(dirEntry.url)
							)
						subdirUpdates.push({
							name: childName,
							url: this.getEntryUrl(childHandle, modifiedDir),
						})
					}
				}
			}

			// Batch-update the directory document in a single change
			const hasChanges =
				newEntries.length > 0 ||
				updatedEntries.length > 0 ||
				deletedNames.length > 0 ||
				subdirUpdates.length > 0
			if (hasChanges && snapshot.rootDirectoryUrl) {
				debug(`push: batch-updating directory "${dirLabel}" (+${newEntries.length} new, ~${updatedEntries.length} updated, -${deletedNames.length} deleted, ${subdirUpdates.length} subdir URL updates)`)
				await this.batchUpdateDirectory(
					snapshot,
					dirPath,
					newEntries,
					updatedEntries,
					deletedNames,
					subdirUpdates
				)
				modifiedDirs.add(dirPath)
				result.directoriesChanged++
			}
		}

		debug(`push: complete - ${result.filesChanged} files, ${result.directoriesChanged} dirs changed, ${result.errors.length} errors`)
		return result
	}

	/**
	 * Phase 2: Pull remote changes to local filesystem
	 */
	private async pullRemoteChanges(
		changes: DetectedChange[],
		snapshot: SyncSnapshot
	): Promise<SyncResult> {
		const result: SyncResult = {
			success: true,
			filesChanged: 0,
			directoriesChanged: 0,
			errors: [],
			warnings: [],
		}

		// Process remote changes
		const remoteChanges = changes.filter(
			c =>
				c.changeType === ChangeType.REMOTE_ONLY ||
				c.changeType === ChangeType.BOTH_CHANGED
		)

		// Sort changes by dependency order (parents before children)
		const sortedChanges = this.sortChangesByDependency(remoteChanges)

		for (const change of sortedChanges) {
			try {
				await this.applyRemoteChangeToLocal(change, snapshot)
				result.filesChanged++
			} catch (error) {
				result.errors.push({
					path: change.path,
					operation: "remote-to-local",
					error: error as Error,
					recoverable: true,
				})
			}
		}

		return result
	}

	/**
	 * Apply remote change to local filesystem
	 */
	private async applyRemoteChangeToLocal(
		change: DetectedChange,
		snapshot: SyncSnapshot
	): Promise<void> {
		const localPath = joinAndNormalizePath(this.rootPath, change.path)

		if (!change.remoteHead) {
			throw new Error(
				`No remote head found for remote change to ${change.path}`
			)
		}

		// Check for null (empty string/Uint8Array are valid content)
		if (change.remoteContent === null) {
			// File was deleted remotely
			await removePath(localPath)
			this.snapshotManager.removeFileEntry(snapshot, change.path)
			return
		}

		// Create or update local file
		await writeFileContent(localPath, change.remoteContent)

		// Update or create snapshot entry for this file
		const snapshotEntry = snapshot.files.get(change.path)
		if (snapshotEntry) {
			// Update existing entry
			snapshotEntry.head = change.remoteHead
		} else {
			// Create new snapshot entry for newly discovered remote file
			// We need to find the remote file's URL from the directory hierarchy
			if (snapshot.rootDirectoryUrl) {
				try {
					const fileEntry = await findFileInDirectoryHierarchy(
						this.repo,
						snapshot.rootDirectoryUrl,
						change.path
					)

					if (fileEntry) {
						const fileHandle = await this.repo.find<FileDocument>(fileEntry.url)
						const entryUrl = this.getEntryUrl(fileHandle, change.path)
						this.snapshotManager.updateFileEntry(snapshot, change.path, {
							path: localPath,
							url: entryUrl,
							head: change.remoteHead,
							extension: getFileExtension(change.path),
							mimeType: getEnhancedMimeType(change.path),
						})
					}
				} catch (error) {
					// Failed to update snapshot - file may have been deleted
					out.taskLine(
						`Warning: Failed to update snapshot for remote file ${change.path}`,
						true
					)
				}
			}
		}
	}

	/**
	 * Apply move to remote documents
	 */
	private async applyMoveToRemote(
		move: MoveCandidate,
		snapshot: SyncSnapshot
	): Promise<void> {
		const fromEntry = snapshot.files.get(move.fromPath)
		if (!fromEntry) return

		// Parse paths
		const toParts = move.toPath.split("/")
		const toFileName = toParts.pop() || ""
		const toDirPath = toParts.join("/")

		// 1) Remove file entry from old directory document
		if (move.fromPath !== move.toPath) {
			await this.removeFileFromDirectory(snapshot, move.fromPath)
		}

		// 2) Ensure destination directory document exists
		await this.ensureDirectoryDocument(snapshot, toDirPath)

		// 3) Update the FileDocument name and content to match new location/state
		try {
			let entryUrl: AutomergeUrl
			let finalHeads: UrlHeads

			if (this.isArtifactPath(move.toPath)) {
				// Artifact files use RawString — no diffing needed, just create a fresh doc
				const content = move.newContent !== undefined
					? move.newContent
					: readDocContent((await (await this.repo.find<FileDocument>(getPlainUrl(fromEntry.url))).doc())?.content)
				const fakeChange: DetectedChange = {
					path: move.toPath,
					changeType: ChangeType.LOCAL_ONLY,
					fileType: content != null && typeof content === "string" ? FileType.TEXT : FileType.BINARY,
					localContent: content,
					remoteContent: null,
				}
				const newHandle = await this.createRemoteFile(fakeChange)
				if (!newHandle) return
				entryUrl = this.getEntryUrl(newHandle, move.toPath)
				finalHeads = newHandle.heads()
			} else {
				// Use plain URL for mutable handle
				const handle = await this.repo.find<FileDocument>(
					getPlainUrl(fromEntry.url)
				)
				const heads = fromEntry.head

				// Update both name and content (if content changed during move)
				changeWithOptionalHeads(handle, heads, (doc: FileDocument) => {
					doc.name = toFileName

					// If new content is provided, update it (handles move + modification case)
					if (move.newContent !== undefined) {
						if (typeof move.newContent === "string") {
							updateTextContent(doc, ["content"], move.newContent)
						} else {
							doc.content = move.newContent
						}
					}
				})

				entryUrl = this.getEntryUrl(handle, move.toPath)
				finalHeads = handle.heads()

				// Track file handle for network sync
				this.handlesByPath.set(move.toPath, handle)
			}

			// 4) Add file entry to destination directory
			await this.addFileToDirectory(snapshot, move.toPath, entryUrl)

			// 5) Update snapshot entries
			this.snapshotManager.removeFileEntry(snapshot, move.fromPath)
			this.snapshotManager.updateFileEntry(snapshot, move.toPath, {
				...fromEntry,
				path: joinAndNormalizePath(this.rootPath, move.toPath),
				url: entryUrl,
				head: finalHeads,
				...(this.isArtifactPath(move.toPath) && move.newContent != null
					? {contentHash: contentHash(move.newContent)}
					: {}),
			})
		} catch (e) {
			// Failed to update file name - file may have been deleted
			out.taskLine(
				`Warning: Failed to rename ${move.fromPath} to ${move.toPath}`,
				true
			)
		}
	}

	/**
	 * Create new remote file document
	 */
	private async createRemoteFile(
		change: DetectedChange
	): Promise<DocHandle<FileDocument> | null> {
		if (change.localContent === null) return null

		const isText = this.isTextContent(change.localContent)
		const isArtifact = this.isArtifactPath(change.path)

		// For artifact files, store text as RawString (immutable snapshot).
		// For regular files, store as collaborative text (empty string + splice).
		const fileDoc: FileDocument = {
			"@patchwork": {type: "file"},
			name: change.path.split("/").pop() || "",
			extension: getFileExtension(change.path),
			mimeType: getEnhancedMimeType(change.path),
			content:
				isText && isArtifact
					? new A.RawString(change.localContent as string) as unknown as string
					: isText
						? ""
						: change.localContent,
			metadata: {
				permissions: 0o644,
			},
		}

		const handle = this.repo.create(fileDoc)

		// For non-artifact text files, splice in the content so it's stored as collaborative text
		if (isText && !isArtifact && typeof change.localContent === "string") {
			handle.change((doc: FileDocument) => {
				updateTextContent(doc, ["content"], change.localContent as string)
			})
		}

		// Always track newly created files for network sync
		// (they always represent a change that needs to sync)
		this.handlesByPath.set(change.path, handle)

		return handle
	}

	/**
	 * Update existing remote file document
	 */
	private async updateRemoteFile(
		url: AutomergeUrl,
		content: string | Uint8Array,
		snapshot: SyncSnapshot,
		filePath: string
	): Promise<void> {
		// Use plain URL for mutable handle
		const handle = await this.repo.find<FileDocument>(getPlainUrl(url))

		// Check if content actually changed before tracking for sync
		const doc = await handle.doc()
		const rawContent = doc?.content

		// For artifact paths, always replace with a new document containing RawString.
		// For non-artifact paths with immutable strings, replace with mutable text.
		// In both cases we create a new document and update the snapshot URL.
		const isArtifact = this.isArtifactPath(filePath)
		if (
			isArtifact ||
			!doc ||
			(rawContent != null && A.isImmutableString(rawContent))
		) {
			if (!isArtifact) {
				out.taskLine(
					`Replacing ${!doc ? 'unavailable' : 'immutable string'} document for ${filePath}`,
					true
				)
			}
			const fakeChange: DetectedChange = {
				path: filePath,
				changeType: ChangeType.LOCAL_ONLY,
				fileType: this.isTextContent(content)
					? FileType.TEXT
					: FileType.BINARY,
				localContent: content,
				remoteContent: null,
			}
			const newHandle = await this.createRemoteFile(fakeChange)
			if (newHandle) {
				const entryUrl = this.getEntryUrl(newHandle, filePath)
				this.snapshotManager.updateFileEntry(snapshot, filePath, {
					path: joinAndNormalizePath(this.rootPath, filePath),
					url: entryUrl,
					head: newHandle.heads(),
					extension: getFileExtension(filePath),
					mimeType: getEnhancedMimeType(filePath),
					...(this.isArtifactPath(filePath)
						? {contentHash: contentHash(content)}
						: {}),
				})
			}
			return
		}

		const currentContent = readDocContent(rawContent)
		const contentChanged = !isContentEqual(content, currentContent)

		// Update snapshot heads even when content is identical
		const snapshotEntry = snapshot.files.get(filePath)
		if (snapshotEntry) {
			// Update snapshot with current document heads
			snapshot.files.set(filePath, {
				...snapshotEntry,
				head: handle.heads(),
			})
		}

		if (!contentChanged) {
			// Content is identical, but we've updated the snapshot heads above
			// This prevents fresh change detection from seeing stale heads
			return
		}

		const heads = snapshotEntry?.head

		if (!heads) {
			throw new Error(`No heads found for ${url}`)
		}

		handle.changeAt(heads, (doc: FileDocument) => {
			if (typeof content === "string") {
				updateTextContent(doc, ["content"], content)
			} else {
				doc.content = content
			}
		})

		// Update snapshot with new heads after content change
		if (snapshotEntry) {
			snapshot.files.set(filePath, {
				...snapshotEntry,
				head: handle.heads(),
			})
		}

		// Only track files that actually changed content
		this.handlesByPath.set(filePath, handle)
	}

	/**
	 * Delete remote file document
	 */
	private async deleteRemoteFile(
		_url: AutomergeUrl,
		_snapshot?: SyncSnapshot,
		_filePath?: string
	): Promise<void> {
		// In Automerge, we don't actually delete documents.
		// The file entry is removed from its parent directory, making the
		// document orphaned. Clearing content via splice is expensive for
		// large text files (every character is a CRDT op), so we skip it.
	}

	/**
	 * Add file entry to appropriate directory document (maintains hierarchy)
	 */
	private async addFileToDirectory(
		snapshot: SyncSnapshot,
		filePath: string,
		fileUrl: AutomergeUrl
	): Promise<void> {
		if (!snapshot.rootDirectoryUrl) return

		const pathParts = filePath.split("/")
		const fileName = pathParts.pop() || ""
		const directoryPath = pathParts.join("/")

		// Get or create the parent directory document
		const parentDirUrl = await this.ensureDirectoryDocument(
			snapshot,
			directoryPath
		)

		// Use plain URL for mutable handle
		const dirHandle = await this.repo.find<DirectoryDocument>(
			getPlainUrl(parentDirUrl)
		)

		let didChange = false
		const snapshotEntry = snapshot.directories.get(directoryPath)
		const heads = snapshotEntry?.head
		changeWithOptionalHeads(dirHandle, heads, (doc: DirectoryDocument) => {
			const existingIndex = doc.docs.findIndex(
				entry => entry.name === fileName && entry.type === "file"
			)
			if (existingIndex === -1) {
				doc.docs.push({
					name: fileName,
					type: "file",
					url: fileUrl,
				})
				didChange = true
			}
		})
		// Always track the directory (even if unchanged) for proper leaf-first sync ordering
		this.handlesByPath.set(directoryPath, dirHandle)

		if (didChange && snapshotEntry) {
			snapshotEntry.head = dirHandle.heads()
		}
	}

	/**
	 * Ensure directory document exists for the given path, creating hierarchy as needed
	 * First checks for existing shared directories before creating new ones
	 */
	private async ensureDirectoryDocument(
		snapshot: SyncSnapshot,
		directoryPath: string
	): Promise<AutomergeUrl> {
		// Root directory case
		if (!directoryPath || directoryPath === "") {
			return snapshot.rootDirectoryUrl!
		}

		// Check if we already have this directory in snapshot
		const existingDir = snapshot.directories.get(directoryPath)
		if (existingDir) {
			return existingDir.url
		}

		// Split path into parent and current directory name
		const pathParts = directoryPath.split("/")
		const currentDirName = pathParts.pop() || ""
		const parentPath = pathParts.join("/")

		// Ensure parent directory exists first (recursive)
		const parentDirUrl = await this.ensureDirectoryDocument(
			snapshot,
			parentPath
		)

		// DISCOVERY: Check if directory already exists in parent on server
		try {
			const parentHandle = await this.repo.find<DirectoryDocument>(parentDirUrl)
			const parentDoc = await parentHandle.doc()

			if (parentDoc) {
				const existingDirEntry = parentDoc.docs.find(
					(entry: {name: string; type: string; url: AutomergeUrl}) =>
						entry.name === currentDirName && entry.type === "folder"
				)

				if (existingDirEntry) {
					// Resolve the actual directory handle and use its current heads
					// Directory entries in parent docs may not carry valid heads
					try {
						const childDirHandle = await this.repo.find<DirectoryDocument>(
							existingDirEntry.url
						)

						// Track discovered directory for sync
						this.handlesByPath.set(directoryPath, childDirHandle)

						// Get appropriate URL for directory entry
						const entryUrl = this.getEntryUrl(childDirHandle, directoryPath)

						// Update snapshot with discovered directory
						this.snapshotManager.updateDirectoryEntry(snapshot, directoryPath, {
							path: joinAndNormalizePath(this.rootPath, directoryPath),
							url: entryUrl,
							head: childDirHandle.heads(),
							entries: [],
						})

						return entryUrl
					} catch (resolveErr) {
						// Failed to resolve directory - fall through to create a fresh directory document
					}
				}
			}
		} catch (error) {
			// Failed to check for existing directory - will create new one
		}

		// CREATE: Directory doesn't exist, create new one
		const dirDoc: DirectoryDocument = {
			"@patchwork": {type: "folder"},
			name: currentDirName,
			title: currentDirName,
			docs: [],
		}

		const dirHandle = this.repo.create(dirDoc)

		// Get appropriate URL for directory entry
		const dirEntryUrl = this.getEntryUrl(dirHandle, directoryPath)

		// Add this directory to its parent
		// Use plain URL for mutable handle
		const parentHandle = await this.repo.find<DirectoryDocument>(
			getPlainUrl(parentDirUrl)
		)

		let didChange = false
		parentHandle.change((doc: DirectoryDocument) => {
			// Double-check that entry doesn't exist (race condition protection)
			const existingIndex = doc.docs.findIndex(
				(entry: {name: string; type: string; url: AutomergeUrl}) =>
					entry.name === currentDirName && entry.type === "folder"
			)
			if (existingIndex === -1) {
				doc.docs.push({
					name: currentDirName,
					type: "folder",
					url: dirEntryUrl,
				})
				didChange = true
			}
		})

		// Track directory handles for sync
		this.handlesByPath.set(directoryPath, dirHandle)
		if (didChange) {
			this.handlesByPath.set(parentPath, parentHandle)

			const parentSnapshotEntry = snapshot.directories.get(parentPath)
			if (parentSnapshotEntry) {
				parentSnapshotEntry.head = parentHandle.heads()
			}
		}

		// Update snapshot with new directory
		this.snapshotManager.updateDirectoryEntry(snapshot, directoryPath, {
			path: joinAndNormalizePath(this.rootPath, directoryPath),
			url: dirEntryUrl,
			head: dirHandle.heads(),
			entries: [],
		})

		return dirEntryUrl
	}

	/**
	 * Remove file entry from directory document
	 */
	private async removeFileFromDirectory(
		snapshot: SyncSnapshot,
		filePath: string
	): Promise<void> {
		if (!snapshot.rootDirectoryUrl) return

		const pathParts = filePath.split("/")
		const fileName = pathParts.pop() || ""
		const directoryPath = pathParts.join("/")

		// Get the parent directory URL
		let parentDirUrl: AutomergeUrl
		if (!directoryPath || directoryPath === "") {
			parentDirUrl = snapshot.rootDirectoryUrl
		} else {
			const existingDir = snapshot.directories.get(directoryPath)
			if (!existingDir) {
				// Directory not found - file may already be removed
				return
			}
			parentDirUrl = existingDir.url
		}

		try {
			// Use plain URL for mutable handle
			const dirHandle = await this.repo.find<DirectoryDocument>(
				getPlainUrl(parentDirUrl)
			)

			// Track this handle for network sync waiting
			this.handlesByPath.set(directoryPath, dirHandle)
			const snapshotEntry = snapshot.directories.get(directoryPath)
			const heads = snapshotEntry?.head
			let didChange = false

			changeWithOptionalHeads(dirHandle, heads, (doc: DirectoryDocument) => {
				const indexToRemove = doc.docs.findIndex(
					entry => entry.name === fileName && entry.type === "file"
				)
				if (indexToRemove !== -1) {
					doc.docs.splice(indexToRemove, 1)
					didChange = true
					out.taskLine(
						`Removed ${fileName} from ${
							formatRelativePath(directoryPath) || "root"
						}`
					)
				}
			})

			if (didChange && snapshotEntry) {
				snapshotEntry.head = dirHandle.heads()
			}
		} catch (error) {
			throw error
		}
	}

	/**
	 * Batch-update a directory document in a single change: add new file entries,
	 * update URLs for modified files, remove deleted entries, and update
	 * subdirectory URLs. This replaces the separate per-file directory mutations
	 * and the post-hoc URL update pass.
	 */
	private async batchUpdateDirectory(
		snapshot: SyncSnapshot,
		dirPath: string,
		newEntries: {name: string; url: AutomergeUrl}[],
		updatedEntries: {name: string; url: AutomergeUrl}[],
		deletedNames: string[],
		subdirUpdates: {name: string; url: AutomergeUrl}[]
	): Promise<void> {
		let dirUrl: AutomergeUrl
		if (!dirPath || dirPath === "") {
			dirUrl = snapshot.rootDirectoryUrl!
		} else {
			const dirEntry = snapshot.directories.get(dirPath)
			if (!dirEntry) return
			dirUrl = dirEntry.url
		}

		const dirHandle = await this.repo.find<DirectoryDocument>(
			getPlainUrl(dirUrl)
		)

		const snapshotEntry = snapshot.directories.get(dirPath)
		const heads = snapshotEntry?.head

		// Determine directory name
		const dirName = dirPath ? dirPath.split("/").pop() || "" : path.basename(this.rootPath)

		changeWithOptionalHeads(dirHandle, heads, (doc: DirectoryDocument) => {
			// Ensure name and title fields are set
			if (!doc.name) doc.name = dirName
			if (!doc.title) doc.title = dirName

			// Remove deleted file entries
			for (const name of deletedNames) {
				const idx = doc.docs.findIndex(
					entry => entry.name === name && entry.type === "file"
				)
				if (idx !== -1) {
					doc.docs.splice(idx, 1)
					out.taskLine(
						`Removed ${name} from ${
							formatRelativePath(dirPath) || "root"
						}`
					)
				}
			}

			// Update URLs for modified files
			for (const {name, url} of updatedEntries) {
				const idx = doc.docs.findIndex(
					entry => entry.name === name && entry.type === "file"
				)
				if (idx !== -1) {
					doc.docs[idx].url = url
				}
			}

			// Add new file entries
			for (const {name, url} of newEntries) {
				const existing = doc.docs.findIndex(
					entry => entry.name === name && entry.type === "file"
				)
				if (existing === -1) {
					doc.docs.push({name, type: "file", url})
				} else {
					// Entry already exists (e.g. from immutable string replacement)
					doc.docs[existing].url = url
				}
			}

			// Update subdirectory URLs with current heads
			for (const {name, url} of subdirUpdates) {
				const idx = doc.docs.findIndex(
					entry => entry.name === name && entry.type === "folder"
				)
				if (idx !== -1) {
					doc.docs[idx].url = url
				}
			}
		})

		// Track directory handle and update snapshot heads
		this.handlesByPath.set(dirPath, dirHandle)
		if (snapshotEntry) {
			snapshotEntry.head = dirHandle.heads()
		}
	}

	/**
	 * Sort changes by dependency order
	 */
	private sortChangesByDependency(changes: DetectedChange[]): DetectedChange[] {
		// Sort by path depth (shallower paths first)
		return changes.sort((a, b) => {
			const depthA = a.path.split("/").length
			const depthB = b.path.split("/").length
			return depthA - depthB
		})
	}

	/**
	 * Get sync status
	 */
	async getStatus(): Promise<{
		snapshot: SyncSnapshot | null
		hasChanges: boolean
		changeCount: number
		lastSync: Date | null
	}> {
		const snapshot = await this.snapshotManager.load()

		if (!snapshot) {
			return {
				snapshot: null,
				hasChanges: false,
				changeCount: 0,
				lastSync: null,
			}
		}

		const changes = await this.changeDetector.detectChanges(snapshot)

		return {
			snapshot,
			hasChanges: changes.length > 0,
			changeCount: changes.length,
			lastSync: new Date(snapshot.timestamp),
		}
	}

	/**
	 * Preview changes without applying them
	 */
	async previewChanges(): Promise<{
		changes: DetectedChange[]
		moves: MoveCandidate[]
		summary: string
	}> {
		const snapshot = await this.snapshotManager.load()
		if (!snapshot) {
			return {
				changes: [],
				moves: [],
				summary: "No snapshot found - run init first",
			}
		}

		const changes = await this.changeDetector.detectChanges(snapshot)
		const {moves} = await this.moveDetector.detectMoves(changes, snapshot)

		const summary = this.generateChangeSummary(changes, moves)

		return {changes, moves, summary}
	}

	/**
	 * Generate human-readable summary of changes
	 */
	private generateChangeSummary(
		changes: DetectedChange[],
		moves: MoveCandidate[]
	): string {
		const localChanges = changes.filter(
			c =>
				c.changeType === ChangeType.LOCAL_ONLY ||
				c.changeType === ChangeType.BOTH_CHANGED
		).length

		const remoteChanges = changes.filter(
			c =>
				c.changeType === ChangeType.REMOTE_ONLY ||
				c.changeType === ChangeType.BOTH_CHANGED
		).length

		const conflicts = changes.filter(
			c => c.changeType === ChangeType.BOTH_CHANGED
		).length

		const parts: string[] = []

		if (localChanges > 0) {
			parts.push(`${localChanges} local change${localChanges > 1 ? "s" : ""}`)
		}

		if (remoteChanges > 0) {
			parts.push(
				`${remoteChanges} remote change${remoteChanges > 1 ? "s" : ""}`
			)
		}

		if (moves.length > 0) {
			parts.push(`${moves.length} potential move${moves.length > 1 ? "s" : ""}`)
		}

		if (conflicts > 0) {
			parts.push(`${conflicts} conflict${conflicts > 1 ? "s" : ""}`)
		}

		if (parts.length === 0) {
			return "No changes detected"
		}

		return parts.join(", ")
	}

	/**
	 * Update the lastSyncAt timestamp on the root directory document
	 */
	private async touchRootDirectory(snapshot: SyncSnapshot): Promise<void> {
		if (!snapshot.rootDirectoryUrl) {
			return
		}

		try {
			const rootHandle = await this.repo.find<DirectoryDocument>(
				snapshot.rootDirectoryUrl
			)

			const snapshotEntry = snapshot.directories.get("")
			const heads = snapshotEntry?.head

			const timestamp = Date.now()

			const version = require("../../package.json").version

			changeWithOptionalHeads(rootHandle, heads, (doc: DirectoryDocument) => {
				doc.lastSyncAt = timestamp
				doc.with = `pushwork@${version}`
			})

			// Track root directory for network sync
			this.handlesByPath.set("", rootHandle)

			if (snapshotEntry) {
				snapshotEntry.head = rootHandle.heads()
			}
		} catch (error) {
			// Failed to update root directory timestamp
		}
	}

}
