const myers = require("myers-diff");

import {
  AutomergeUrl,
  Repo,
  updateText,
  DocHandle,
  UrlHeads,
} from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";
import {
  SyncSnapshot,
  SyncResult,
  SyncError,
  SyncOperation,
  PendingSyncOperation,
  FileDocument,
  DirectoryDocument,
  FileType,
  ChangeType,
  MoveCandidate,
} from "../types";
import {
  readFileContent,
  writeFileContent,
  removePath,
  movePath,
  ensureDirectoryExists,
  getFileExtension,
  normalizePath,
  getRelativePath,
  getEnhancedMimeType,
  isEnhancedTextFile,
} from "../utils";
import { isContentEqual } from "../utils/content";
import { waitForSync, getSyncServerStorageId } from "../utils/network-sync";
import { SnapshotManager } from "./snapshot";
import { ChangeDetector, DetectedChange } from "./change-detection";
import { MoveDetector } from "./move-detection";

/**
 * Bidirectional sync engine implementing two-phase sync
 */
export class SyncEngine {
  private snapshotManager: SnapshotManager;
  private changeDetector: ChangeDetector;
  private moveDetector: MoveDetector;
  private networkSyncEnabled: boolean = true;
  private handlesToWaitOn: DocHandle<unknown>[] = [];
  private syncServerStorageId?: string;

  constructor(
    private repo: Repo,
    private rootPath: string,
    excludePatterns: string[] = [],
    networkSyncEnabled: boolean = true,
    syncServerStorageId?: string
  ) {
    this.snapshotManager = new SnapshotManager(rootPath);
    this.changeDetector = new ChangeDetector(repo, rootPath, excludePatterns);
    this.moveDetector = new MoveDetector();
    this.networkSyncEnabled = networkSyncEnabled;
    this.syncServerStorageId = syncServerStorageId;
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
  async commitLocal(dryRun = false): Promise<SyncResult> {
    console.log(`🚀 Starting local commit process (dryRun: ${dryRun})`);

    const result: SyncResult = {
      success: false,
      filesChanged: 0,
      directoriesChanged: 0,
      errors: [],
      warnings: [],
    };

    try {
      // Load current snapshot
      console.log(`📸 Loading current snapshot...`);
      let snapshot = await this.snapshotManager.load();
      if (!snapshot) {
        console.log(`📸 No snapshot found, creating empty one`);
        snapshot = this.snapshotManager.createEmpty();
      } else {
        console.log(`📸 Snapshot loaded with ${snapshot.files.size} files`);
        if (snapshot.rootDirectoryUrl) {
          console.log(`🔗 Root directory URL: ${snapshot.rootDirectoryUrl}`);
        }
      }

      // Backup snapshot before starting
      if (!dryRun) {
        console.log(`💾 Backing up snapshot...`);
        await this.snapshotManager.backup();
      }

      // Detect all changes
      console.log(`🔍 Detecting changes...`);
      const changes = await this.changeDetector.detectChanges(snapshot);
      console.log(`🔍 Found ${changes.length} changes`);

      // Detect moves
      console.log(`📦 Detecting moves...`);
      const { moves, remainingChanges } = await this.moveDetector.detectMoves(
        changes,
        snapshot,
        this.rootPath
      );
      console.log(
        `📦 Found ${moves.length} moves, ${remainingChanges.length} remaining changes`
      );

      // Apply local changes only (no network sync)
      console.log(`💾 Committing local changes...`);
      const commitResult = await this.pushLocalChanges(
        remainingChanges,
        moves,
        snapshot,
        dryRun
      );
      console.log(
        `💾 Commit complete: ${commitResult.filesChanged} files changed`
      );

      result.filesChanged += commitResult.filesChanged;
      result.directoriesChanged += commitResult.directoriesChanged;
      result.errors.push(...commitResult.errors);
      result.warnings.push(...commitResult.warnings);

      // Touch root directory if any changes were made
      const hasChanges =
        result.filesChanged > 0 || result.directoriesChanged > 0;
      if (hasChanges) {
        await this.touchRootDirectory(snapshot, dryRun);
      }

      // Save updated snapshot if not dry run
      if (!dryRun) {
        await this.snapshotManager.save(snapshot);
      }

      result.success = result.errors.length === 0;
      console.log(`💾 Local commit ${result.success ? "completed" : "failed"}`);

      return result;
    } catch (error) {
      console.error(`❌ Local commit failed: ${error}`);
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
  async sync(dryRun = false): Promise<SyncResult> {
    const syncStartTime = Date.now();
    const timings: { [key: string]: number } = {};

    const result: SyncResult = {
      success: false,
      filesChanged: 0,
      directoriesChanged: 0,
      errors: [],
      warnings: [],
    };

    // Reset handles to wait on
    this.handlesToWaitOn = [];

    try {
      // Load current snapshot
      const t0 = Date.now();
      let snapshot = await this.snapshotManager.load();
      timings["load_snapshot"] = Date.now() - t0;
      if (!snapshot) {
        snapshot = this.snapshotManager.createEmpty();
      }

      // Backup snapshot before starting
      const t1 = Date.now();
      if (!dryRun) {
        await this.snapshotManager.backup();
      }
      timings["backup_snapshot"] = Date.now() - t1;

      // Detect all changes
      const t2 = Date.now();
      const changes = await this.changeDetector.detectChanges(snapshot);
      timings["detect_changes"] = Date.now() - t2;

      // Detect moves
      const t3 = Date.now();
      const { moves, remainingChanges } = await this.moveDetector.detectMoves(
        changes,
        snapshot,
        this.rootPath
      );
      timings["detect_moves"] = Date.now() - t3;

      if (changes.length > 0) {
        console.log(`🔄 Syncing ${changes.length} changes...`);
      }

      // Phase 1: Push local changes to remote
      const t4 = Date.now();
      const phase1Result = await this.pushLocalChanges(
        remainingChanges,
        moves,
        snapshot,
        dryRun
      );
      timings["phase1_push"] = Date.now() - t4;

      result.filesChanged += phase1Result.filesChanged;
      result.directoriesChanged += phase1Result.directoriesChanged;
      result.errors.push(...phase1Result.errors);
      result.warnings.push(...phase1Result.warnings);

      // Always wait for network sync when enabled (not just when local changes exist)
      // This is critical for clone scenarios where we need to pull remote changes
      const t5 = Date.now();
      if (!dryRun && this.networkSyncEnabled) {
        try {
          // If we have a root directory URL, wait for it to sync
          if (snapshot.rootDirectoryUrl) {
            const rootHandle = await this.repo.find<DirectoryDocument>(
              snapshot.rootDirectoryUrl
            );
            this.handlesToWaitOn.push(rootHandle);
          }

          if (this.handlesToWaitOn.length > 0) {
            const tWaitStart = Date.now();
            await waitForSync(
              this.handlesToWaitOn,
              getSyncServerStorageId(this.syncServerStorageId)
            );
            timings["network_sync"] = Date.now() - tWaitStart;

            // CRITICAL: Wait a bit after our changes reach the server to allow
            // time for WebSocket to deliver OTHER peers' changes to us.
            // waitForSync only ensures OUR changes reached the server, not that
            // we've RECEIVED changes from other peers. This delay allows the
            // WebSocket protocol to propagate peer changes before we re-detect.
            // Without this, concurrent operations on different peers can miss
            // each other due to timing races.
            //
            // Optimization: Only wait if we pushed changes (shorter delay if no changes)
            const tDelayStart = Date.now();
            const delayMs = phase1Result.filesChanged > 0 ? 200 : 100;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            timings["post_sync_delay"] = Date.now() - tDelayStart;
          }
        } catch (error) {
          console.error(`❌ Network sync failed: ${error}`);
          result.warnings.push(`Network sync failed: ${error}`);
        }
      }
      timings["total_network"] = Date.now() - t5;

      // Re-detect remote changes after network sync to ensure fresh state
      // This fixes race conditions where we detect changes before server propagation
      // NOTE: We DON'T update snapshot heads yet - that would prevent detecting remote changes!
      const t6 = Date.now();
      const freshChanges = await this.changeDetector.detectChanges(snapshot);
      const freshRemoteChanges = freshChanges.filter(
        (c) =>
          c.changeType === ChangeType.REMOTE_ONLY ||
          c.changeType === ChangeType.BOTH_CHANGED
      );
      timings["redetect_changes"] = Date.now() - t6;

      // Phase 2: Pull remote changes to local using fresh detection
      const t7 = Date.now();
      const phase2Result = await this.pullRemoteChanges(
        freshRemoteChanges,
        snapshot,
        dryRun
      );
      timings["phase2_pull"] = Date.now() - t7;
      result.filesChanged += phase2Result.filesChanged;
      result.directoriesChanged += phase2Result.directoriesChanged;
      result.errors.push(...phase2Result.errors);
      result.warnings.push(...phase2Result.warnings);

      // CRITICAL FIX: Update snapshot heads AFTER pulling remote changes
      // This ensures that change detection can find remote changes, and we only
      // update the snapshot after the filesystem is in sync with the documents
      const t8 = Date.now();
      if (!dryRun) {
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
            // Handle might not exist if file was deleted, skip
            console.warn(`Could not update heads for ${filePath}: ${error}`);
          }
        }

        // Update directory document heads
        for (const [dirPath, snapshotEntry] of snapshot.directories.entries()) {
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
            // Handle might not exist if directory was deleted, skip
            console.warn(
              `Could not update heads for directory ${dirPath}: ${error}`
            );
          }
        }
      }
      timings["update_snapshot_heads"] = Date.now() - t8;

      // Touch root directory if any changes were made during sync
      const t9 = Date.now();
      const hasChanges =
        result.filesChanged > 0 || result.directoriesChanged > 0;
      if (hasChanges) {
        await this.touchRootDirectory(snapshot, dryRun);
      }
      timings["touch_root"] = Date.now() - t9;

      // Save updated snapshot if not dry run
      const t10 = Date.now();
      if (!dryRun) {
        await this.snapshotManager.save(snapshot);
      }
      timings["save_snapshot"] = Date.now() - t10;

      // Output timing breakdown if enabled via environment variable
      if (process.env.PUSHWORK_TIMING === "1") {
        const totalTime = Date.now() - syncStartTime;
        console.error("\n⏱️  Sync Timing Breakdown:");
        for (const [key, ms] of Object.entries(timings)) {
          const pct = ((ms / totalTime) * 100).toFixed(1);
          console.error(
            `  ${key.padEnd(25)} ${ms.toString().padStart(5)}ms (${pct}%)`
          );
        }
        console.error(
          `  ${"TOTAL".padEnd(25)} ${totalTime
            .toString()
            .padStart(5)}ms (100.0%)\n`
        );
      }

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
    snapshot: SyncSnapshot,
    dryRun: boolean
  ): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      filesChanged: 0,
      directoriesChanged: 0,
      errors: [],
      warnings: [],
    };

    // Process moves first
    for (const move of moves) {
      if (this.moveDetector.shouldAutoApply(move)) {
        try {
          await this.applyMoveToRemote(move, snapshot, dryRun);
          result.filesChanged++;
        } catch (error) {
          result.errors.push({
            path: move.fromPath,
            operation: "move",
            error: error as Error,
            recoverable: true,
          });
        }
      } else if (this.moveDetector.shouldPromptUser(move)) {
        // Instead of creating a persistent loop, perform delete+create semantics
        // so the working tree converges even without auto-apply.
        result.warnings.push(
          `Potential move detected: ${this.moveDetector.formatMove(
            move
          )} (${Math.round(move.similarity * 100)}% similar)`
        );
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
        await this.applyLocalChangeToRemote(change, snapshot, dryRun);
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
    snapshot: SyncSnapshot,
    dryRun: boolean
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
        await this.applyRemoteChangeToLocal(change, snapshot, dryRun);
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
    snapshot: SyncSnapshot,
    dryRun: boolean
  ): Promise<void> {
    const snapshotEntry = snapshot.files.get(change.path);

    // CRITICAL: Check for null explicitly, not falsy values
    // Empty strings "" and empty Uint8Array are valid file content!
    if (change.localContent === null) {
      // File was deleted locally
      if (snapshotEntry) {
        console.log(`🗑️  ${change.path}`);
        await this.deleteRemoteFile(
          snapshotEntry.url,
          dryRun,
          snapshot,
          change.path
        );
        // Remove from directory document
        await this.removeFileFromDirectory(snapshot, change.path, dryRun);
        if (!dryRun) {
          this.snapshotManager.removeFileEntry(snapshot, change.path);
        }
      }
      return;
    }

    if (!snapshotEntry) {
      // New file
      console.log(`➕ ${change.path}`);
      const handle = await this.createRemoteFile(change, dryRun);
      if (!dryRun && handle) {
        await this.addFileToDirectory(
          snapshot,
          change.path,
          handle.url,
          dryRun
        );

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
      console.log(`📝 ${change.path}`);

      // log the change in detail for debugging
      // split out remotea nd local content so we don't overwhelm the logs
      const { remoteContent, localContent, ...rest } = change;
      console.log(`🔍 Change in detail:`, rest);

      // compare the local and remote content and make a diff so we can
      // see what happened between the two
      const { diff, changed } = require("myers-diff");
      const lhs = change.remoteContent ? change.remoteContent.toString() : "";
      const rhs = change.localContent ? change.localContent.toString() : "";
      const changes = diff(lhs, rhs, { compare: "chars" });

      for (const change of changes) {
        if (changed(change.lhs)) {
          // deleted
          const { pos, text, del, length } = change.lhs;
          console.log(`🔍 Deleted:`, { pos, text, del, length });
        }
        if (changed(change.rhs)) {
          // added
          const { pos, text, add, length } = change.rhs;
          console.log(`🔍 Added:`, { pos, text, add, length });
        }
      }

      await this.updateRemoteFile(
        snapshotEntry.url,
        change.localContent,
        dryRun,
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
    snapshot: SyncSnapshot,
    dryRun: boolean
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
      console.log(`🗑️  ${change.path}`);
      if (!dryRun) {
        await removePath(localPath);
        this.snapshotManager.removeFileEntry(snapshot, change.path);
      }
      return;
    }

    // Create or update local file
    if (change.changeType === ChangeType.REMOTE_ONLY) {
      console.log(`⬇️  ${change.path}`);
    } else {
      console.log(`🔀 ${change.path}`);
    }

    if (!dryRun) {
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
            const fileEntry = await this.findFileInDirectoryHierarchy(
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
            console.warn(
              `Failed to update snapshot for remote file ${change.path}: ${error}`
            );
          }
        }
      }
    }
  }

  /**
   * Apply move to remote documents
   */
  private async applyMoveToRemote(
    move: MoveCandidate,
    snapshot: SyncSnapshot,
    dryRun: boolean
  ): Promise<void> {
    const fromEntry = snapshot.files.get(move.fromPath);
    if (!fromEntry) return;

    // Parse paths
    const fromParts = move.fromPath.split("/");
    const fromFileName = fromParts.pop() || "";
    const fromDirPath = fromParts.join("/");

    const toParts = move.toPath.split("/");
    const toFileName = toParts.pop() || "";
    const toDirPath = toParts.join("/");

    if (!dryRun) {
      // 1) Remove file entry from old directory document
      if (move.fromPath !== move.toPath) {
        await this.removeFileFromDirectory(snapshot, move.fromPath, dryRun);
      }

      // 2) Ensure destination directory document exists and add file entry there
      const destDirUrl = await this.ensureDirectoryDocument(
        snapshot,
        toDirPath,
        dryRun
      );
      await this.addFileToDirectory(
        snapshot,
        move.toPath,
        fromEntry.url,
        dryRun
      );

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
              const isText = this.isTextContent(move.newContent);
              if (isText && typeof move.newContent === "string") {
                updateText(doc, ["content"], move.newContent);
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
              const isText = this.isTextContent(move.newContent);
              if (isText && typeof move.newContent === "string") {
                updateText(doc, ["content"], move.newContent);
              } else {
                doc.content = move.newContent;
              }
            }
          });
        }
        // Track file handle for network sync
        this.handlesToWaitOn.push(handle);
      } catch (e) {
        console.warn(
          `Failed to update file name for move ${move.fromPath} -> ${move.toPath}: ${e}`
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
  }

  /**
   * Create new remote file document
   */
  private async createRemoteFile(
    change: DetectedChange,
    dryRun: boolean
  ): Promise<DocHandle<FileDocument> | null> {
    // CRITICAL: Check for null explicitly, not falsy values
    // Empty strings "" and empty Uint8Array are valid file content!
    if (dryRun || change.localContent === null) return null;

    const isText = this.isTextContent(change.localContent);

    // Create initial document structure
    const fileDoc: FileDocument = {
      "@patchwork": { type: "file" },
      name: change.path.split("/").pop() || "",
      extension: getFileExtension(change.path),
      mimeType: getEnhancedMimeType(change.path),
      content: isText ? "" : change.localContent, // Empty string for text, actual content for binary
      metadata: {
        permissions: 0o644,
      },
    };

    const handle = this.repo.create(fileDoc);

    // For text files, use updateText to set the content properly
    if (isText && typeof change.localContent === "string") {
      handle.change((doc: FileDocument) => {
        updateText(doc, ["content"], change.localContent as string);
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
    dryRun: boolean,
    snapshot: SyncSnapshot,
    filePath: string
  ): Promise<void> {
    if (dryRun) return;

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
      console.log(
        `🔍 Content is identical, but we've updated the snapshot heads above`
      );
      return;
    }

    const heads = snapshotEntry?.head;

    if (!heads) {
      throw new Error(`No heads found for ${url}`);
    }

    handle.changeAt(heads, (doc: FileDocument) => {
      const isText = this.isTextContent(content);
      if (isText && typeof content === "string") {
        updateText(doc, ["content"], content);
      } else {
        doc.content = content;
      }
    });

    // Update snapshot with new heads after content change
    if (!dryRun && snapshotEntry) {
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
    dryRun: boolean,
    snapshot?: SyncSnapshot,
    filePath?: string
  ): Promise<void> {
    if (dryRun) return;

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
        doc.content = "";
      });
    } else {
      handle.change((doc: FileDocument) => {
        doc.content = "";
      });
    }
  }

  /**
   * Add file entry to appropriate directory document (maintains hierarchy)
   */
  private async addFileToDirectory(
    snapshot: SyncSnapshot,
    filePath: string,
    fileUrl: AutomergeUrl,
    dryRun: boolean
  ): Promise<void> {
    if (dryRun || !snapshot.rootDirectoryUrl) return;

    const pathParts = filePath.split("/");
    const fileName = pathParts.pop() || "";
    const directoryPath = pathParts.join("/");

    // Get or create the parent directory document
    const parentDirUrl = await this.ensureDirectoryDocument(
      snapshot,
      directoryPath,
      dryRun
    );

    console.log(
      `🔗 Adding ${fileName} (${fileUrl}) to directory ${parentDirUrl} (path: ${directoryPath})`
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
    directoryPath: string,
    dryRun: boolean
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
      parentPath,
      dryRun
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
            if (!dryRun) {
              this.snapshotManager.updateDirectoryEntry(
                snapshot,
                directoryPath,
                {
                  path: normalizePath(this.rootPath + "/" + directoryPath),
                  url: existingDirEntry.url,
                  head: childHeads,
                  entries: [],
                }
              );
            }

            return existingDirEntry.url;
          } catch (resolveErr) {
            console.warn(
              `Failed to resolve child directory ${currentDirName} at ${directoryPath}: ${resolveErr}`
            );
            // Fall through to create a fresh directory document
          }
        }
      }
    } catch (error) {
      console.warn(
        `Failed to check for existing directory ${currentDirName}: ${error}`
      );
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
    if (!dryRun) {
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
    }

    return dirHandle.url;
  }

  /**
   * Remove file entry from directory document
   */
  private async removeFileFromDirectory(
    snapshot: SyncSnapshot,
    filePath: string,
    dryRun: boolean
  ): Promise<void> {
    if (dryRun || !snapshot.rootDirectoryUrl) return;

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
        console.warn(
          `Directory ${directoryPath} not found in snapshot for file removal`
        );
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
            console.log(
              `🗑️  Removed ${fileName} from directory ${
                directoryPath || "root"
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
            console.log(
              `🗑️  Removed ${fileName} from directory ${
                directoryPath || "root"
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
      console.warn(
        `Failed to remove ${fileName} from directory ${
          directoryPath || "root"
        }: ${error}`
      );
      throw error;
    }
  }

  /**
   * Find a file in the directory hierarchy by path
   */
  private async findFileInDirectoryHierarchy(
    directoryUrl: AutomergeUrl,
    filePath: string
  ): Promise<{ name: string; type: string; url: AutomergeUrl } | null> {
    try {
      const pathParts = filePath.split("/");
      let currentDirUrl = directoryUrl;

      // Navigate through directories to find the parent directory
      for (let i = 0; i < pathParts.length - 1; i++) {
        const dirName = pathParts[i];
        const dirHandle = await this.repo.find<DirectoryDocument>(
          currentDirUrl
        );
        const dirDoc = await dirHandle.doc();

        if (!dirDoc) return null;

        const subDirEntry = dirDoc.docs.find(
          (entry: { name: string; type: string; url: AutomergeUrl }) =>
            entry.name === dirName && entry.type === "folder"
        );

        if (!subDirEntry) return null;
        currentDirUrl = subDirEntry.url;
      }

      // Now look for the file in the final directory
      const fileName = pathParts[pathParts.length - 1];
      const finalDirHandle = await this.repo.find<DirectoryDocument>(
        currentDirUrl
      );
      const finalDirDoc = await finalDirHandle.doc();

      if (!finalDirDoc) return null;

      const fileEntry = finalDirDoc.docs.find(
        (entry: { name: string; type: string; url: AutomergeUrl }) =>
          entry.name === fileName && entry.type === "file"
      );

      return fileEntry || null;
    } catch (error) {
      console.warn(
        `Failed to find file ${filePath} in directory hierarchy: ${error}`
      );
      return null;
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
    const { moves } = await this.moveDetector.detectMoves(
      changes,
      snapshot,
      this.rootPath
    );

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
  private async touchRootDirectory(
    snapshot: SyncSnapshot,
    dryRun: boolean
  ): Promise<void> {
    if (dryRun || !snapshot.rootDirectoryUrl) {
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

      console.log(
        `🕒 Updated root directory lastSyncAt to ${new Date(
          timestamp
        ).toISOString()}`
      );
    } catch (error) {
      console.warn(`Failed to update root directory lastSyncAt: ${error}`);
    }
  }
}
