import { AutomergeUrl, Repo, updateText } from "@automerge/automerge-repo";
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
  getMimeType,
  getFileExtension,
  normalizePath,
  getRelativePath,
} from "../utils";
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

  constructor(
    private repo: Repo,
    private rootPath: string,
    excludePatterns: string[] = []
  ) {
    this.snapshotManager = new SnapshotManager(rootPath);
    this.changeDetector = new ChangeDetector(repo, rootPath, excludePatterns);
    this.moveDetector = new MoveDetector();
  }

  /**
   * Determine if content should be treated as text for Automerge text operations
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
   * Run full bidirectional sync
   */
  async sync(dryRun = false): Promise<SyncResult> {
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
      if (!dryRun) {
        await this.snapshotManager.backup();
      }

      // Detect all changes
      const changes = await this.changeDetector.detectChanges(snapshot);

      // Detect moves
      const { moves, remainingChanges } = await this.moveDetector.detectMoves(
        changes,
        snapshot,
        this.rootPath
      );

      // Phase 1: Push local changes to remote
      const phase1Result = await this.pushLocalChanges(
        remainingChanges,
        moves,
        snapshot,
        dryRun
      );
      result.filesChanged += phase1Result.filesChanged;
      result.directoriesChanged += phase1Result.directoriesChanged;
      result.errors.push(...phase1Result.errors);
      result.warnings.push(...phase1Result.warnings);

      // Phase 2: Pull remote changes to local
      const phase2Result = await this.pullRemoteChanges(
        remainingChanges,
        snapshot,
        dryRun
      );
      result.filesChanged += phase2Result.filesChanged;
      result.directoriesChanged += phase2Result.directoriesChanged;
      result.errors.push(...phase2Result.errors);
      result.warnings.push(...phase2Result.warnings);

      // Save updated snapshot if not dry run
      if (!dryRun) {
        await this.snapshotManager.save(snapshot);
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
        result.warnings.push(
          `Potential move detected: ${this.moveDetector.formatMove(move)}`
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

    if (!change.localContent) {
      // File was deleted locally
      if (snapshotEntry) {
        await this.deleteRemoteFile(snapshotEntry.url, dryRun);
        // Remove from root directory document
        const fileName = change.path.split("/").pop() || "";
        await this.removeFileFromRootDirectory(snapshot, fileName, dryRun);
        if (!dryRun) {
          this.snapshotManager.removeFileEntry(snapshot, change.path);
        }
      }
      return;
    }

    if (!snapshotEntry) {
      // New file
      const url = await this.createRemoteFile(change, dryRun);
      if (!dryRun && url) {
        // Add to root directory document
        const fileName = change.path.split("/").pop() || "";
        await this.addFileToRootDirectory(snapshot, fileName, url, dryRun);

        this.snapshotManager.updateFileEntry(snapshot, change.path, {
          path: normalizePath(this.rootPath + "/" + change.path),
          url,
          head: await this.getCurrentRemoteHead(url),
          extension: getFileExtension(change.path),
          mimeType: getMimeType(change.path),
        });
      }
    } else {
      // Update existing file
      await this.updateRemoteFile(
        snapshotEntry.url,
        change.localContent,
        dryRun
      );
      if (!dryRun) {
        snapshotEntry.head = await this.getCurrentRemoteHead(snapshotEntry.url);
      }
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

    if (!change.remoteContent) {
      // File was deleted remotely
      if (!dryRun) {
        await removePath(localPath);
        this.snapshotManager.removeFileEntry(snapshot, change.path);
      }
      return;
    }

    // Create or update local file
    if (!dryRun) {
      await writeFileContent(localPath, change.remoteContent);

      const snapshotEntry = snapshot.files.get(change.path);
      if (snapshotEntry) {
        snapshotEntry.head = change.remoteHead || snapshotEntry.head;
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

    // Update parent directory documents to reflect the move
    if (!dryRun) {
      // Remove from old location
      this.snapshotManager.removeFileEntry(snapshot, move.fromPath);

      // Add to new location
      this.snapshotManager.updateFileEntry(snapshot, move.toPath, {
        ...fromEntry,
        path: normalizePath(this.rootPath + "/" + move.toPath),
      });
    }
  }

  /**
   * Create new remote file document
   */
  private async createRemoteFile(
    change: DetectedChange,
    dryRun: boolean
  ): Promise<AutomergeUrl | null> {
    if (dryRun || !change.localContent) return null;

    const isText = this.isTextContent(change.localContent);

    // Create initial document structure
    const fileDoc: FileDocument = {
      name: change.path.split("/").pop() || "",
      extension: getFileExtension(change.path),
      mimeType: getMimeType(change.path),
      contents: isText ? "" : change.localContent, // Empty string for text, actual content for binary
      metadata: {
        permissions: 0o644,
      },
    };

    const handle = this.repo.create(fileDoc);

    // For text files, use updateText to set the content properly
    if (isText && typeof change.localContent === "string") {
      handle.change((doc: FileDocument) => {
        updateText(doc, ["contents"], change.localContent as string);
      });
    }

    return handle.url;
  }

  /**
   * Update existing remote file document
   */
  private async updateRemoteFile(
    url: AutomergeUrl,
    content: string | Uint8Array,
    dryRun: boolean
  ): Promise<void> {
    if (dryRun) return;

    const handle = await this.repo.find(url);
    handle.change((doc: FileDocument) => {
      const isText = this.isTextContent(content);

      if (isText && typeof content === "string") {
        // Use updateText for text content to get proper CRDT merging
        updateText(doc, ["contents"], content);
      } else {
        // Direct assignment for binary content
        doc.contents = content;
      }
    });
  }

  /**
   * Delete remote file document
   */
  private async deleteRemoteFile(
    url: AutomergeUrl,
    dryRun: boolean
  ): Promise<void> {
    if (dryRun) return;

    // In Automerge, we don't actually delete documents
    // They become orphaned and will be garbage collected
    // For now, we just mark them as deleted by clearing content
    const handle = await this.repo.find(url);
    handle.change((doc: FileDocument) => {
      doc.contents = "";
    });
  }

  /**
   * Add file entry to root directory document
   */
  private async addFileToRootDirectory(
    snapshot: SyncSnapshot,
    fileName: string,
    fileUrl: AutomergeUrl,
    dryRun: boolean
  ): Promise<void> {
    if (dryRun || !snapshot.rootDirectoryUrl) return;

    const dirHandle = await this.repo.find(snapshot.rootDirectoryUrl);
    dirHandle.change((doc: DirectoryDocument) => {
      // Check if entry already exists
      const existingIndex = doc.docs.findIndex(
        (entry) => entry.name === fileName
      );
      if (existingIndex === -1) {
        doc.docs.push({
          name: fileName,
          type: "file",
          url: fileUrl,
        });
      }
    });
  }

  /**
   * Remove file entry from root directory document
   */
  private async removeFileFromRootDirectory(
    snapshot: SyncSnapshot,
    fileName: string,
    dryRun: boolean
  ): Promise<void> {
    if (dryRun || !snapshot.rootDirectoryUrl) return;

    try {
      const dirHandle = await this.repo.find(snapshot.rootDirectoryUrl);
      dirHandle.change((doc: DirectoryDocument) => {
        // Find the index of the entry to remove
        const indexToRemove = doc.docs.findIndex(
          (entry) => entry.name === fileName
        );
        if (indexToRemove !== -1) {
          // Use splice to mutate the array in place
          doc.docs.splice(indexToRemove, 1);
        }
      });
    } catch (error) {
      console.warn(
        `Failed to remove ${fileName} from root directory: ${error}`
      );
      throw error;
    }
  }

  /**
   * Get current head of remote document
   */
  private async getCurrentRemoteHead(url: AutomergeUrl): Promise<string> {
    try {
      const handle = await this.repo.find(url);
      const doc = await handle.doc();

      if (!doc) return "";

      const heads = A.getHeads(doc);
      return heads[0] || "";
    } catch {
      return "";
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
}
