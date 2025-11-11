import { AutomergeUrl, Repo, DocHandle } from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";
import {
  SyncSnapshot,
  SyncResult,
  FileDocument,
  DirectoryDocument,
  ChangeType,
  MoveCandidate,
  DirectoryConfig,
} from "../types";
import {
  writeFileContent,
  removePath,
  getFileExtension,
  normalizePath,
  getEnhancedMimeType,
  formatRelativePath,
  findFileInDirectoryHierarchy,
} from "../utils";
import { isContentEqual } from "../utils/content";
import { waitForSync } from "../utils/network-sync";
import { SnapshotManager } from "./snapshot";
import { ChangeDetector, DetectedChange } from "./change-detection";
import { MoveDetector } from "./move-detection";
import { span, attr } from "../tracing";
import { out } from "../cli/output";

/**
 * Post-sync delay constants for network propagation
 * These delays allow the WebSocket protocol to propagate peer changes after
 * our changes reach the server. waitForSync only ensures OUR changes reached
 * the server, not that we've RECEIVED changes from other peers.
 */
const POST_SYNC_DELAY_WITH_CHANGES_MS = 200; // After we pushed changes
const POST_SYNC_DELAY_NO_CHANGES_MS = 100; // When no changes pushed (shorter delay)

/**
 * Bidirectional sync engine implementing two-phase sync
 */
export class SyncEngine {
  private snapshotManager: SnapshotManager;
  private changeDetector: ChangeDetector;
  private moveDetector: MoveDetector;
  private handlesToWaitOn: DocHandle<unknown>[] = [];
  private config: DirectoryConfig;

  constructor(
    private repo: Repo,
    private rootPath: string,
    config: DirectoryConfig
  ) {
    this.config = config;
    this.snapshotManager = new SnapshotManager(rootPath);
    this.changeDetector = new ChangeDetector(
      repo,
      rootPath,
      config.defaults.exclude_patterns
    );
    this.moveDetector = new MoveDetector(config.sync.move_detection_threshold);
  }

  /**
   * Determine if content should be treated as text for Automerge text operations
   * Note: This method checks the runtime type. File type detection happens
   * during reading with isEnhancedTextFile() which now has better dev file support.
   */
  private isTextContent(content: string | Uint8Array): boolean {
    // Simply check the actual type of the content
    return typeof content === "string";
  }

  /**
   * Set the root directory URL in the snapshot
   */
  async setRootDirectoryUrl(url: AutomergeUrl): Promise<void> {
    let snapshot = await this.snapshotManager.load();
    if (!snapshot) {
      snapshot = this.snapshotManager.createEmpty();
    }
    snapshot.rootDirectoryUrl = url;
    await this.snapshotManager.save(snapshot);
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
    };

    try {
      // Load current snapshot
      let snapshot = await this.snapshotManager.load();
      if (!snapshot) {
        snapshot = this.snapshotManager.createEmpty();
      }

      // Backup snapshot before starting
      await this.snapshotManager.backup();

      // Detect all changes
      const changes = await this.changeDetector.detectChanges(snapshot);

      // Detect moves
      const { moves, remainingChanges } = await this.moveDetector.detectMoves(
        changes,
        snapshot
      );

      // Apply local changes only (no network sync)
      const commitResult = await this.pushLocalChanges(
        remainingChanges,
        moves,
        snapshot
      );

      result.filesChanged += commitResult.filesChanged;
      result.directoriesChanged += commitResult.directoriesChanged;
      result.errors.push(...commitResult.errors);
      result.warnings.push(...commitResult.warnings);

      // Touch root directory if any changes were made
      const hasChanges =
        result.filesChanged > 0 || result.directoriesChanged > 0;
      if (hasChanges) {
        await this.touchRootDirectory(snapshot);
      }

      // Save updated snapshot
      await this.snapshotManager.save(snapshot);

      result.success = result.errors.length === 0;

      return result;
    } catch (error) {
      result.errors.push({
        path: this.rootPath,
        operation: "commitLocal",
        error: error instanceof Error ? error : new Error(String(error)),
        recoverable: true,
      });
      result.success = false;
      return result;
    }
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
    };

    // Reset handles to wait on
    this.handlesToWaitOn = [];

    try {
      // Load current snapshot
      let snapshot = await span(
        "load_snapshot",
        (async () => {
          const s = await this.snapshotManager.load();
          return s || this.snapshotManager.createEmpty();
        })()
      );

      // Backup snapshot before starting
      await span("backup_snapshot", this.snapshotManager.backup());

      // Detect all changes
      const changes = await span(
        "detect_changes",
        this.changeDetector.detectChanges(snapshot)
      );

      // Detect moves
      const { moves, remainingChanges } = await span(
        "detect_moves",
        this.moveDetector.detectMoves(changes, snapshot)
      );

      // Phase 1: Push local changes to remote
      const phase1Result = await this.pushLocalChanges(
        remainingChanges,
        moves,
        snapshot
      );

      result.filesChanged += phase1Result.filesChanged;
      result.directoriesChanged += phase1Result.directoriesChanged;
      result.errors.push(...phase1Result.errors);
      result.warnings.push(...phase1Result.warnings);

      // Always wait for network sync when enabled (not just when local changes exist)
      // This is critical for clone scenarios where we need to pull remote changes
      await span(
        "network",
        (async () => {
          attr("documents_to_sync", this.handlesToWaitOn.length);

          if (this.config.sync_enabled) {
            try {
              // If we have a root directory URL, wait for it to sync
              if (snapshot.rootDirectoryUrl) {
                const rootDirUrl = snapshot.rootDirectoryUrl;
                const rootHandle = await span(
                  "find_root_directory",
                  this.repo.find<DirectoryDocument>(rootDirUrl)
                );
                this.handlesToWaitOn.push(rootHandle);
              }

              if (this.handlesToWaitOn.length > 0) {
                await span(
                  "network_sync",
                  waitForSync(
                    this.handlesToWaitOn,
                    this.config.sync_server_storage_id
                  )
                );

                // CRITICAL: Wait a bit after our changes reach the server to allow
                // time for WebSocket to deliver OTHER peers' changes to us.
                // waitForSync only ensures OUR changes reached the server, not that
                // we've RECEIVED changes from other peers. This delay allows the
                // WebSocket protocol to propagate peer changes before we re-detect.
                // Without this, concurrent operations on different peers can miss
                // each other due to timing races.
                //
                // Optimization: Only wait if we pushed changes (shorter delay if no changes)

                await span(
                  "post_sync_delay",
                  (async () => {
                    const delayMs =
                      phase1Result.filesChanged > 0
                        ? POST_SYNC_DELAY_WITH_CHANGES_MS
                        : POST_SYNC_DELAY_NO_CHANGES_MS;
                    await new Promise((resolve) =>
                      setTimeout(resolve, delayMs)
                    );
                  })()
                );
              }
            } catch (error) {
              out.taskLine(`Network sync failed: ${error}`, true);
              result.warnings.push(`Network sync failed: ${error}`);
            }
          }
        })()
      );

      // Re-detect remote changes after network sync to ensure fresh state
      // This fixes race conditions where we detect changes before server propagation
      // NOTE: We DON'T update snapshot heads yet - that would prevent detecting remote changes!
      const freshChanges = await span(
        "redetect_changes",
        this.changeDetector.detectChanges(snapshot)
      );
      const freshRemoteChanges = freshChanges.filter(
        (c) =>
          c.changeType === ChangeType.REMOTE_ONLY ||
          c.changeType === ChangeType.BOTH_CHANGED
      );

      // Phase 2: Pull remote changes to local using fresh detection
      const phase2Result = await this.pullRemoteChanges(
        freshRemoteChanges,
        snapshot
      );
      result.filesChanged += phase2Result.filesChanged;
      result.directoriesChanged += phase2Result.directoriesChanged;
      result.errors.push(...phase2Result.errors);
      result.warnings.push(...phase2Result.warnings);

      // CRITICAL FIX: Update snapshot heads AFTER pulling remote changes
      // This ensures that change detection can find remote changes, and we only
      // update the snapshot after the filesystem is in sync with the documents
      await span(
        "update_snapshot_heads",
        (async () => {
          // Update file document heads
          for (const [filePath, snapshotEntry] of snapshot.files.entries()) {
            try {
              const handle = await this.repo.find(snapshotEntry.url);
              const currentHeads = handle.heads();
              if (!A.equals(currentHeads, snapshotEntry.head)) {
                // Update snapshot with current heads after pulling changes
                snapshot.files.set(filePath, {
                  ...snapshotEntry,
                  head: currentHeads,
                });
              }
            } catch (error) {
              // Handle might not exist if file was deleted
            }
          }

          // Update directory document heads
          for (const [
            dirPath,
            snapshotEntry,
          ] of snapshot.directories.entries()) {
            try {
              const handle = await this.repo.find(snapshotEntry.url);
              const currentHeads = handle.heads();
              if (!A.equals(currentHeads, snapshotEntry.head)) {
                // Update snapshot with current heads after pulling changes
                snapshot.directories.set(dirPath, {
                  ...snapshotEntry,
                  head: currentHeads,
                });
              }
            } catch (error) {
              // Handle might not exist if directory was deleted
            }
          }
        })()
      );

      // Touch root directory if any changes were made during sync
      const hasChanges =
        result.filesChanged > 0 || result.directoriesChanged > 0;
      if (hasChanges) {
        await span("touch_root", this.touchRootDirectory(snapshot));
      }

      // Save updated snapshot if not dry run
      await span("save_snapshot", this.snapshotManager.save(snapshot));

      result.success = result.errors.length === 0;
      return result;
    } catch (error) {
      result.errors.push({
        path: "sync",
        operation: "full-sync",
        error: error as Error,
        recoverable: false,
      });
      return result;
    }
  }

  /**
   * Phase 1: Push local changes to Automerge documents
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
    };

    // Process moves first - all detected moves are applied
    for (const move of moves) {
      try {
        await this.applyMoveToRemote(move, snapshot);
        result.filesChanged++;
      } catch (error) {
        result.errors.push({
          path: move.fromPath,
          operation: "move",
          error: error as Error,
          recoverable: true,
        });
      }
    }

    // Process local changes
    const localChanges = changes.filter(
      (c) =>
        c.changeType === ChangeType.LOCAL_ONLY ||
        c.changeType === ChangeType.BOTH_CHANGED
    );

    for (const change of localChanges) {
      try {
        await this.applyLocalChangeToRemote(change, snapshot);
        result.filesChanged++;
      } catch (error) {
        result.errors.push({
          path: change.path,
          operation: "local-to-remote",
          error: error as Error,
          recoverable: true,
        });
      }
    }

    return result;
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
    };

    // Process remote changes
    const remoteChanges = changes.filter(
      (c) =>
        c.changeType === ChangeType.REMOTE_ONLY ||
        c.changeType === ChangeType.BOTH_CHANGED
    );

    // Sort changes by dependency order (parents before children)
    const sortedChanges = this.sortChangesByDependency(remoteChanges);

    for (const change of sortedChanges) {
      try {
        await this.applyRemoteChangeToLocal(change, snapshot);
        result.filesChanged++;
      } catch (error) {
        result.errors.push({
          path: change.path,
          operation: "remote-to-local",
          error: error as Error,
          recoverable: true,
        });
      }
    }

    return result;
  }

  /**
   * Apply local file change to remote Automerge document
   */
  private async applyLocalChangeToRemote(
    change: DetectedChange,
    snapshot: SyncSnapshot
  ): Promise<void> {
    const snapshotEntry = snapshot.files.get(change.path);

    // CRITICAL: Check for null explicitly, not falsy values
    // Empty strings "" and empty Uint8Array are valid file content!
    if (change.localContent === null) {
      // File was deleted locally
      if (snapshotEntry) {
        await this.deleteRemoteFile(snapshotEntry.url, snapshot, change.path);
        // Remove from directory document
        await this.removeFileFromDirectory(snapshot, change.path);
        this.snapshotManager.removeFileEntry(snapshot, change.path);
      }
      return;
    }

    if (!snapshotEntry) {
      // New file
      const handle = await this.createRemoteFile(change);
      if (handle) {
        await this.addFileToDirectory(snapshot, change.path, handle.url);

        // CRITICAL FIX: Update snapshot with heads AFTER adding to directory
        // The addFileToDirectory call above may have changed the document heads
        this.snapshotManager.updateFileEntry(snapshot, change.path, {
          path: normalizePath(this.rootPath + "/" + change.path),
          url: handle.url,
          head: handle.heads(),
          extension: getFileExtension(change.path),
          mimeType: getEnhancedMimeType(change.path),
        });
      }
    } else {
      // Update existing file
      await this.updateRemoteFile(
        snapshotEntry.url,
        change.localContent,
        snapshot,
        change.path
      );
    }
  }

  /**
   * Apply remote change to local filesystem
   */
  private async applyRemoteChangeToLocal(
    change: DetectedChange,
    snapshot: SyncSnapshot
  ): Promise<void> {
    const localPath = normalizePath(this.rootPath + "/" + change.path);

    if (!change.remoteHead) {
      throw new Error(
        `No remote head found for remote change to ${change.path}`
      );
    }

    // CRITICAL: Check for null explicitly, not falsy values
    // Empty strings "" and empty Uint8Array are valid file content!
    if (change.remoteContent === null) {
      // File was deleted remotely
      await removePath(localPath);
      this.snapshotManager.removeFileEntry(snapshot, change.path);
      return;
    }

    // Create or update local file
    await writeFileContent(localPath, change.remoteContent);

    // Update or create snapshot entry for this file
    const snapshotEntry = snapshot.files.get(change.path);
    if (snapshotEntry) {
      // Update existing entry
      snapshotEntry.head = change.remoteHead;
    } else {
      // Create new snapshot entry for newly discovered remote file
      // We need to find the remote file's URL from the directory hierarchy
      if (snapshot.rootDirectoryUrl) {
        try {
          const fileEntry = await findFileInDirectoryHierarchy(
            this.repo,
            snapshot.rootDirectoryUrl,
            change.path
          );

          if (fileEntry) {
            this.snapshotManager.updateFileEntry(snapshot, change.path, {
              path: localPath,
              url: fileEntry.url,
              head: change.remoteHead,
              extension: getFileExtension(change.path),
              mimeType: getEnhancedMimeType(change.path),
            });
          }
        } catch (error) {
          // Failed to update snapshot - file may have been deleted
          out.taskLine(
            `Warning: Failed to update snapshot for remote file ${change.path}`,
            true
          );
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
    const fromEntry = snapshot.files.get(move.fromPath);
    if (!fromEntry) return;

    // Parse paths
    const toParts = move.toPath.split("/");
    const toFileName = toParts.pop() || "";
    const toDirPath = toParts.join("/");

    // 1) Remove file entry from old directory document
    if (move.fromPath !== move.toPath) {
      await this.removeFileFromDirectory(snapshot, move.fromPath);
    }

    // 2) Ensure destination directory document exists and add file entry there
    await this.ensureDirectoryDocument(snapshot, toDirPath);
    await this.addFileToDirectory(snapshot, move.toPath, fromEntry.url);

    // 3) Update the FileDocument name and content to match new location/state
    try {
      const handle = await this.repo.find<FileDocument>(fromEntry.url);
      const heads = fromEntry.head;

      // Update both name and content (if content changed during move)
      if (heads && heads.length > 0) {
        handle.changeAt(heads, (doc: FileDocument) => {
          doc.name = toFileName;

          // If new content is provided, update it (handles move + modification case)
          if (move.newContent !== undefined) {
            if (typeof move.newContent === "string") {
              doc.content = new A.ImmutableString(move.newContent);
            } else {
              doc.content = move.newContent;
            }
          }
        });
      } else {
        handle.change((doc: FileDocument) => {
          doc.name = toFileName;

          // If new content is provided, update it (handles move + modification case)
          if (move.newContent !== undefined) {
            if (typeof move.newContent === "string") {
              doc.content = new A.ImmutableString(move.newContent);
            } else {
              doc.content = move.newContent;
            }
          }
        });
      }
      // Track file handle for network sync
      this.handlesToWaitOn.push(handle);
    } catch (e) {
      // Failed to update file name - file may have been deleted
      out.taskLine(
        `Warning: Failed to rename ${move.fromPath} to ${move.toPath}`,
        true
      );
    }

    // 4) Update snapshot entries
    this.snapshotManager.removeFileEntry(snapshot, move.fromPath);
    this.snapshotManager.updateFileEntry(snapshot, move.toPath, {
      ...fromEntry,
      path: normalizePath(this.rootPath + "/" + move.toPath),
      head: fromEntry.head, // will be updated later when heads advance
    });
  }

  /**
   * Create new remote file document
   */
  private async createRemoteFile(
    change: DetectedChange
  ): Promise<DocHandle<FileDocument> | null> {
    // CRITICAL: Check for null explicitly, not falsy values
    // Empty strings "" and empty Uint8Array are valid file content!
    if (change.localContent === null) return null;

    const isText = this.isTextContent(change.localContent);

    // Create initial document structure
    const fileDoc: FileDocument = {
      "@patchwork": { type: "file" },
      name: change.path.split("/").pop() || "",
      extension: getFileExtension(change.path),
      mimeType: getEnhancedMimeType(change.path),
      content: isText
        ? new A.ImmutableString("")
        : typeof change.localContent === "string"
        ? new A.ImmutableString(change.localContent)
        : change.localContent, // Empty ImmutableString for text, wrap strings for safety, actual content for binary
      metadata: {
        permissions: 0o644,
      },
    };

    const handle = this.repo.create(fileDoc);

    // For text files, use ImmutableString for better performance
    if (isText && typeof change.localContent === "string") {
      handle.change((doc: FileDocument) => {
        doc.content = new A.ImmutableString(change.localContent as string);
      });
    }

    // Always track newly created files for network sync
    // (they always represent a change that needs to sync)
    this.handlesToWaitOn.push(handle);

    return handle;
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
    const handle = await this.repo.find<FileDocument>(url);

    // Check if content actually changed before tracking for sync
    const doc = await handle.doc();
    const currentContent = doc?.content;
    const contentChanged = !isContentEqual(content, currentContent);

    // CRITICAL FIX: Always update snapshot heads, even when content is identical
    // This prevents stale head issues that cause false change detection
    const snapshotEntry = snapshot.files.get(filePath);
    if (snapshotEntry) {
      // Update snapshot with current document heads
      snapshot.files.set(filePath, {
        ...snapshotEntry,
        head: handle.heads(),
      });
    }

    if (!contentChanged) {
      // Content is identical, but we've updated the snapshot heads above
      // This prevents fresh change detection from seeing stale heads
      return;
    }

    const heads = snapshotEntry?.head;

    if (!heads) {
      throw new Error(`No heads found for ${url}`);
    }

    handle.changeAt(heads, (doc: FileDocument) => {
      if (typeof content === "string") {
        doc.content = new A.ImmutableString(content);
      } else {
        doc.content = content;
      }
    });

    // Update snapshot with new heads after content change
    if (snapshotEntry) {
      snapshot.files.set(filePath, {
        ...snapshotEntry,
        head: handle.heads(),
      });
    }

    // Only track files that actually changed content
    this.handlesToWaitOn.push(handle);
  }

  /**
   * Delete remote file document
   */
  private async deleteRemoteFile(
    url: AutomergeUrl,
    snapshot?: SyncSnapshot,
    filePath?: string
  ): Promise<void> {
    // In Automerge, we don't actually delete documents
    // They become orphaned and will be garbage collected
    // For now, we just mark them as deleted by clearing content
    const handle = await this.repo.find<FileDocument>(url);
    // const doc = await handle.doc(); // no longer needed
    let heads;
    if (snapshot && filePath) {
      heads = snapshot.files.get(filePath)?.head;
    }
    if (heads) {
      handle.changeAt(heads, (doc: FileDocument) => {
        doc.content = new A.ImmutableString("");
      });
    } else {
      handle.change((doc: FileDocument) => {
        doc.content = new A.ImmutableString("");
      });
    }
  }

  /**
   * Add file entry to appropriate directory document (maintains hierarchy)
   */
  private async addFileToDirectory(
    snapshot: SyncSnapshot,
    filePath: string,
    fileUrl: AutomergeUrl
  ): Promise<void> {
    if (!snapshot.rootDirectoryUrl) return;

    const pathParts = filePath.split("/");
    const fileName = pathParts.pop() || "";
    const directoryPath = pathParts.join("/");

    // Get or create the parent directory document
    const parentDirUrl = await this.ensureDirectoryDocument(
      snapshot,
      directoryPath
    );

    const dirHandle = await this.repo.find<DirectoryDocument>(parentDirUrl);

    let didChange = false;
    const snapshotEntry = snapshot.directories.get(directoryPath);
    const heads = snapshotEntry?.head;
    if (heads) {
      dirHandle.changeAt(heads, (doc: DirectoryDocument) => {
        const existingIndex = doc.docs.findIndex(
          (entry) => entry.name === fileName && entry.type === "file"
        );
        if (existingIndex === -1) {
          doc.docs.push({
            name: fileName,
            type: "file",
            url: fileUrl,
          });
          didChange = true;
        }
      });
    } else {
      dirHandle.change((doc: DirectoryDocument) => {
        const existingIndex = doc.docs.findIndex(
          (entry) => entry.name === fileName && entry.type === "file"
        );
        if (existingIndex === -1) {
          doc.docs.push({
            name: fileName,
            type: "file",
            url: fileUrl,
          });
          didChange = true;
        }
      });
    }
    if (didChange) {
      this.handlesToWaitOn.push(dirHandle);

      // CRITICAL FIX: Update snapshot with new directory heads immediately
      // This prevents stale head issues that cause convergence problems
      if (snapshotEntry) {
        snapshotEntry.head = dirHandle.heads();
      }
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
      return snapshot.rootDirectoryUrl!;
    }

    // Check if we already have this directory in snapshot
    const existingDir = snapshot.directories.get(directoryPath);
    if (existingDir) {
      return existingDir.url;
    }

    // Split path into parent and current directory name
    const pathParts = directoryPath.split("/");
    const currentDirName = pathParts.pop() || "";
    const parentPath = pathParts.join("/");

    // Ensure parent directory exists first (recursive)
    const parentDirUrl = await this.ensureDirectoryDocument(
      snapshot,
      parentPath
    );

    // DISCOVERY: Check if directory already exists in parent on server
    try {
      const parentHandle = await this.repo.find<DirectoryDocument>(
        parentDirUrl
      );
      const parentDoc = await parentHandle.doc();

      if (parentDoc) {
        const existingDirEntry = parentDoc.docs.find(
          (entry: { name: string; type: string; url: AutomergeUrl }) =>
            entry.name === currentDirName && entry.type === "folder"
        );

        if (existingDirEntry) {
          // Resolve the actual directory handle and use its current heads
          // Directory entries in parent docs may not carry valid heads
          try {
            const childDirHandle = await this.repo.find<DirectoryDocument>(
              existingDirEntry.url
            );
            const childHeads = childDirHandle.heads();

            // Update snapshot with discovered directory using validated heads
            this.snapshotManager.updateDirectoryEntry(snapshot, directoryPath, {
              path: normalizePath(this.rootPath + "/" + directoryPath),
              url: existingDirEntry.url,
              head: childHeads,
              entries: [],
            });

            return existingDirEntry.url;
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
      "@patchwork": { type: "folder" },
      docs: [],
    };

    const dirHandle = this.repo.create(dirDoc);

    // Add this directory to its parent
    const parentHandle = await this.repo.find<DirectoryDocument>(parentDirUrl);

    let didChange = false;
    parentHandle.change((doc: DirectoryDocument) => {
      // Double-check that entry doesn't exist (race condition protection)
      const existingIndex = doc.docs.findIndex(
        (entry: { name: string; type: string; url: AutomergeUrl }) =>
          entry.name === currentDirName && entry.type === "folder"
      );
      if (existingIndex === -1) {
        doc.docs.push({
          name: currentDirName,
          type: "folder",
          url: dirHandle.url,
        });
        didChange = true;
      }
    });

    // Track directory handles for sync
    this.handlesToWaitOn.push(dirHandle);
    if (didChange) {
      this.handlesToWaitOn.push(parentHandle);

      // CRITICAL FIX: Update parent directory heads in snapshot immediately
      // This prevents stale head issues when parent directory is modified
      const parentSnapshotEntry = snapshot.directories.get(parentPath);
      if (parentSnapshotEntry) {
        parentSnapshotEntry.head = parentHandle.heads();
      }
    }

    // Update snapshot with new directory
    this.snapshotManager.updateDirectoryEntry(snapshot, directoryPath, {
      path: normalizePath(this.rootPath + "/" + directoryPath),
      url: dirHandle.url,
      head: dirHandle.heads(),
      entries: [],
    });

    return dirHandle.url;
  }

  /**
   * Remove file entry from directory document
   */
  private async removeFileFromDirectory(
    snapshot: SyncSnapshot,
    filePath: string
  ): Promise<void> {
    if (!snapshot.rootDirectoryUrl) return;

    const pathParts = filePath.split("/");
    const fileName = pathParts.pop() || "";
    const directoryPath = pathParts.join("/");

    // Get the parent directory URL
    let parentDirUrl: AutomergeUrl;
    if (!directoryPath || directoryPath === "") {
      parentDirUrl = snapshot.rootDirectoryUrl;
    } else {
      const existingDir = snapshot.directories.get(directoryPath);
      if (!existingDir) {
        // Directory not found - file may already be removed
        return;
      }
      parentDirUrl = existingDir.url;
    }

    try {
      const dirHandle = await this.repo.find<DirectoryDocument>(parentDirUrl);

      // Track this handle for network sync waiting
      this.handlesToWaitOn.push(dirHandle);
      const snapshotEntry = snapshot.directories.get(directoryPath);
      const heads = snapshotEntry?.head;
      let didChange = false;

      if (heads) {
        dirHandle.changeAt(heads, (doc: DirectoryDocument) => {
          const indexToRemove = doc.docs.findIndex(
            (entry) => entry.name === fileName && entry.type === "file"
          );
          if (indexToRemove !== -1) {
            doc.docs.splice(indexToRemove, 1);
            didChange = true;
            out.taskLine(
              `Removed ${fileName} from ${
                formatRelativePath(directoryPath) || "root"
              }`
            );
          }
        });
      } else {
        dirHandle.change((doc: DirectoryDocument) => {
          const indexToRemove = doc.docs.findIndex(
            (entry) => entry.name === fileName && entry.type === "file"
          );
          if (indexToRemove !== -1) {
            doc.docs.splice(indexToRemove, 1);
            didChange = true;
            out.taskLine(
              `Removed ${fileName} from ${
                formatRelativePath(directoryPath) || "root"
              }`
            );
          }
        });
      }

      // CRITICAL FIX: Update snapshot with new directory heads immediately
      // This prevents stale head issues that cause convergence problems
      if (didChange && snapshotEntry) {
        snapshotEntry.head = dirHandle.heads();
      }
    } catch (error) {
      // Failed to remove from directory - re-throw for caller to handle
      throw error;
    }
  }

  /**
   * Sort changes by dependency order
   */
  private sortChangesByDependency(changes: DetectedChange[]): DetectedChange[] {
    // Sort by path depth (shallower paths first)
    return changes.sort((a, b) => {
      const depthA = a.path.split("/").length;
      const depthB = b.path.split("/").length;
      return depthA - depthB;
    });
  }

  /**
   * Get sync status
   */
  async getStatus(): Promise<{
    snapshot: SyncSnapshot | null;
    hasChanges: boolean;
    changeCount: number;
    lastSync: Date | null;
  }> {
    const snapshot = await this.snapshotManager.load();

    if (!snapshot) {
      return {
        snapshot: null,
        hasChanges: false,
        changeCount: 0,
        lastSync: null,
      };
    }

    const changes = await this.changeDetector.detectChanges(snapshot);

    return {
      snapshot,
      hasChanges: changes.length > 0,
      changeCount: changes.length,
      lastSync: new Date(snapshot.timestamp),
    };
  }

  /**
   * Preview changes without applying them
   */
  async previewChanges(): Promise<{
    changes: DetectedChange[];
    moves: MoveCandidate[];
    summary: string;
  }> {
    const snapshot = await this.snapshotManager.load();
    if (!snapshot) {
      return {
        changes: [],
        moves: [],
        summary: "No snapshot found - run init first",
      };
    }

    const changes = await this.changeDetector.detectChanges(snapshot);
    const { moves } = await this.moveDetector.detectMoves(changes, snapshot);

    const summary = this.generateChangeSummary(changes, moves);

    return { changes, moves, summary };
  }

  /**
   * Generate human-readable summary of changes
   */
  private generateChangeSummary(
    changes: DetectedChange[],
    moves: MoveCandidate[]
  ): string {
    const localChanges = changes.filter(
      (c) =>
        c.changeType === ChangeType.LOCAL_ONLY ||
        c.changeType === ChangeType.BOTH_CHANGED
    ).length;

    const remoteChanges = changes.filter(
      (c) =>
        c.changeType === ChangeType.REMOTE_ONLY ||
        c.changeType === ChangeType.BOTH_CHANGED
    ).length;

    const conflicts = changes.filter(
      (c) => c.changeType === ChangeType.BOTH_CHANGED
    ).length;

    const parts: string[] = [];

    if (localChanges > 0) {
      parts.push(`${localChanges} local change${localChanges > 1 ? "s" : ""}`);
    }

    if (remoteChanges > 0) {
      parts.push(
        `${remoteChanges} remote change${remoteChanges > 1 ? "s" : ""}`
      );
    }

    if (moves.length > 0) {
      parts.push(
        `${moves.length} potential move${moves.length > 1 ? "s" : ""}`
      );
    }

    if (conflicts > 0) {
      parts.push(`${conflicts} conflict${conflicts > 1 ? "s" : ""}`);
    }

    if (parts.length === 0) {
      return "No changes detected";
    }

    return parts.join(", ");
  }

  /**
   * Update the lastSyncAt timestamp on the root directory document
   */
  private async touchRootDirectory(snapshot: SyncSnapshot): Promise<void> {
    if (!snapshot.rootDirectoryUrl) {
      return;
    }

    try {
      const rootHandle = await this.repo.find<DirectoryDocument>(
        snapshot.rootDirectoryUrl
      );

      const snapshotEntry = snapshot.directories.get("");
      const heads = snapshotEntry?.head;

      const timestamp = Date.now();

      if (heads) {
        rootHandle.changeAt(heads, (doc: DirectoryDocument) => {
          doc.lastSyncAt = timestamp;
        });
      } else {
        rootHandle.change((doc: DirectoryDocument) => {
          doc.lastSyncAt = timestamp;
        });
      }

      // Track root directory for network sync
      this.handlesToWaitOn.push(rootHandle);

      // CRITICAL FIX: Update root directory heads in snapshot immediately
      // This prevents stale head issues when root directory is modified
      if (snapshotEntry) {
        snapshotEntry.head = rootHandle.heads();
      }
    } catch (error) {
      // Failed to update root directory timestamp
    }
  }
}
