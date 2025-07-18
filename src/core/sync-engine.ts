import {
  AutomergeUrl,
  Repo,
  updateText,
  DocHandle,
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
  getMimeType,
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
    console.log(`🚀 Starting sync process (dryRun: ${dryRun})`);

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

      // Phase 1: Push local changes to remote
      console.log(`⬆️  Phase 1: Pushing local changes...`);
      const phase1Result = await this.pushLocalChanges(
        remainingChanges,
        moves,
        snapshot,
        dryRun
      );
      console.log(
        `⬆️  Phase 1 complete: ${phase1Result.filesChanged} files changed`
      );

      result.filesChanged += phase1Result.filesChanged;
      result.directoriesChanged += phase1Result.directoriesChanged;
      result.errors.push(...phase1Result.errors);
      result.warnings.push(...phase1Result.warnings);

      // Always wait for network sync when enabled (not just when local changes exist)
      // This is critical for clone scenarios where we need to pull remote changes
      if (!dryRun && this.networkSyncEnabled) {
        try {
          // If we have a root directory URL, wait for it to sync
          if (snapshot.rootDirectoryUrl) {
            const rootHandle = await this.repo.find<DirectoryDocument>(
              snapshot.rootDirectoryUrl
            );
            console.log(
              `🏗️  Adding root directory to sync wait: ${snapshot.rootDirectoryUrl}`
            );
            this.handlesToWaitOn.push(rootHandle);
          }

          console.log(
            `🔄 Total handles to wait for: ${this.handlesToWaitOn.length}`
          );

          if (this.handlesToWaitOn.length > 0) {
            await waitForSync(
              this.handlesToWaitOn,
              getSyncServerStorageId(this.syncServerStorageId)
            );
          } else {
            console.log("⚠️  No documents to wait for network sync");
          }
        } catch (error) {
          console.error(`❌ Network sync failed: ${error}`);
          result.warnings.push(`Network sync failed: ${error}`);
        }
      }

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
      const url = await this.createRemoteFile(change, dryRun);
      if (!dryRun && url) {
        // Add to appropriate directory document (maintains hierarchy)
        await this.addFileToDirectory(snapshot, change.path, url, dryRun);

        this.snapshotManager.updateFileEntry(snapshot, change.path, {
          path: normalizePath(this.rootPath + "/" + change.path),
          url,
          head: await this.getCurrentRemoteHead(url),
          extension: getFileExtension(change.path),
          mimeType: getEnhancedMimeType(change.path),
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

      // Update or create snapshot entry for this file
      const snapshotEntry = snapshot.files.get(change.path);
      if (snapshotEntry) {
        // Update existing entry
        snapshotEntry.head = change.remoteHead || snapshotEntry.head;
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
                head:
                  change.remoteHead ||
                  (await this.getCurrentRemoteHead(fileEntry.url)),
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
      "@patchwork": { type: "file" },
      name: change.path.split("/").pop() || "",
      extension: getFileExtension(change.path),
      mimeType: getMimeType(change.path),
      contents: isText ? "" : change.localContent, // Empty string for text, actual content for binary
      metadata: {
        permissions: 0o644,
      },
    };

    const handle = this.repo.create(fileDoc);
    console.log(`🔄 Created file document: ${handle.url} for ${change.path}`);

    // For text files, use updateText to set the content properly
    if (isText && typeof change.localContent === "string") {
      handle.change((doc: FileDocument) => {
        updateText(doc, ["contents"], change.localContent as string);
      });
      console.log(`📝 Updated text content for ${change.path}`);
    }

    // Always track newly created files for network sync
    // (they always represent a change that needs to sync)
    this.handlesToWaitOn.push(handle);

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

    const handle = await this.repo.find<FileDocument>(url);

    // Check if content actually changed before tracking for sync
    const currentDoc = await handle.doc();
    const currentContent = currentDoc?.contents;
    const contentChanged = !isContentEqual(content, currentContent);

    if (!contentChanged) {
      console.log(`📝 No content change for ${url}, skipping sync tracking`);
      return;
    }

    console.log(`📝 Content changed for ${url}, tracking for sync`);

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

    // Only track files that actually changed content
    this.handlesToWaitOn.push(handle);
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
    const handle = await this.repo.find<FileDocument>(url);
    handle.change((doc: FileDocument) => {
      doc.contents = "";
    });
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

    dirHandle.change((doc: DirectoryDocument) => {
      // Check if entry already exists
      const existingIndex = doc.docs.findIndex(
        (entry) => entry.name === fileName && entry.type === "file"
      );
      if (existingIndex === -1) {
        doc.docs.push({
          name: fileName,
          type: "file",
          url: fileUrl,
        });
        console.log(
          `✅ Added ${fileName} to directory ${
            directoryPath || "root"
          }. Total entries: ${doc.docs.length}`
        );
        didChange = true;
      } else {
        console.log(
          `⚠️  File ${fileName} already exists in directory ${
            directoryPath || "root"
          }`
        );
      }
    });

    // Only track directory handle if we actually made changes
    if (didChange) {
      this.handlesToWaitOn.push(dirHandle);
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
          console.log(
            `📁 REUSING existing directory ${currentDirName} at ${existingDirEntry.url}`
          );

          // Update snapshot with discovered directory
          if (!dryRun) {
            this.snapshotManager.updateDirectoryEntry(snapshot, directoryPath, {
              path: normalizePath(this.rootPath + "/" + directoryPath),
              url: existingDirEntry.url,
              head: "", // Directory documents don't have meaningful heads for our purposes
              entries: [],
            });
          }

          return existingDirEntry.url;
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
    console.log(
      `📁 Created NEW directory document: ${dirHandle.url} for ${directoryPath}`
    );

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
        console.log(
          `📁 Added NEW directory ${currentDirName} to parent ${
            parentPath || "root"
          }`
        );
        didChange = true;
      } else {
        console.log(
          `⚠️  Directory ${currentDirName} was added by another process`
        );
      }
    });

    // Track directory handles for sync
    if (!dryRun) {
      this.handlesToWaitOn.push(dirHandle);
      if (didChange) {
        this.handlesToWaitOn.push(parentHandle);
      }

      // Update snapshot with new directory
      this.snapshotManager.updateDirectoryEntry(snapshot, directoryPath, {
        path: normalizePath(this.rootPath + "/" + directoryPath),
        url: dirHandle.url,
        head: "", // Directory documents don't have meaningful heads for our purposes
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

      dirHandle.change((doc: DirectoryDocument) => {
        // Find the index of the entry to remove
        const indexToRemove = doc.docs.findIndex(
          (entry) => entry.name === fileName && entry.type === "file"
        );
        if (indexToRemove !== -1) {
          // Use splice to mutate the array in place
          doc.docs.splice(indexToRemove, 1);
          console.log(
            `🗑️  Removed ${fileName} from directory ${directoryPath || "root"}`
          );
        }
      });
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
   * Get current head of remote document
   */
  private async getCurrentRemoteHead(url: AutomergeUrl): Promise<string> {
    try {
      const handle = await this.repo.find<FileDocument>(url);
      const doc = await handle.doc();

      if (!doc) return "";

      const heads = A.getHeads(doc);
      return heads[0] || "";
    } catch {
      return "";
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
}
