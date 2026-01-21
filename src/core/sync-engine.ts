import {
  AutomergeUrl,
  Repo,
  DocHandle,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";
import {
  SyncSnapshot,
  SyncResult,
  FileDocument,
  DirectoryDocument,
  ChangeType,
  MoveCandidate,
  DirectoryConfig,
  DetectedChange,
} from "../types";
import {
  writeFileContent,
  removePath,
  getFileExtension,
  getEnhancedMimeType,
  formatRelativePath,
  findFileInDirectoryHierarchy,
  joinAndNormalizePath,
  getPlainUrl,
} from "../utils";
import { isContentEqual } from "../utils/content";
import { waitForSync, waitForBidirectionalSync } from "../utils/network-sync";
import { SnapshotManager } from "./snapshot";
import { ChangeDetector } from "./change-detection";
import { MoveDetector } from "./move-detection";
import { out } from "../utils/output";

/**
 * Sync configuration constants
 */
const BIDIRECTIONAL_SYNC_TIMEOUT_MS = 5000; // Timeout for bidirectional sync stability check

/**
 * Bidirectional sync engine implementing two-phase sync
 */
export class SyncEngine {
  private snapshotManager: SnapshotManager;
  private changeDetector: ChangeDetector;
  private moveDetector: MoveDetector;
  // Map from path to handle for leaf-first sync ordering
  // Path depth determines sync order (deepest first)
  private handlesByPath: Map<string, DocHandle<unknown>> = new Map();
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
      config.exclude_patterns
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
   * Get a versioned URL from a handle (includes current heads).
   * This ensures clients can fetch the exact version of the document.
   */
  private getVersionedUrl(handle: DocHandle<unknown>): AutomergeUrl {
    const { documentId } = parseAutomergeUrl(handle.url);
    const heads = handle.heads();
    return stringifyAutomergeUrl({ documentId, heads });
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

      // Update directory URLs with current heads after all children are populated
      await this.updateDirectoryUrlsLeafFirst(snapshot);

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

    // Reset tracked handles for sync
    this.handlesByPath = new Map();

    try {
      // Load current snapshot
      const snapshot =
        (await this.snapshotManager.load()) ||
        this.snapshotManager.createEmpty();

      // Wait for initial sync to receive any pending remote changes
      if (this.config.sync_enabled && snapshot.rootDirectoryUrl) {
        try {
          await waitForBidirectionalSync(
            this.repo,
            snapshot.rootDirectoryUrl,
            this.config.sync_server_storage_id,
            {
              timeoutMs: 3000, // Short timeout for initial sync
              pollIntervalMs: 100,
              stableChecksRequired: 3,
            }
          );
        } catch (error) {
          out.taskLine(`Initial sync: ${error}`, true);
        }
      }

      // Detect all changes
      const changes = await this.changeDetector.detectChanges(snapshot);

      // Detect moves
      const { moves, remainingChanges } = await this.moveDetector.detectMoves(
        changes,
        snapshot
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

      // Update directory URLs with current heads after all children are populated
      await this.updateDirectoryUrlsLeafFirst(snapshot);

      // Wait for network sync (important for clone scenarios)
      if (this.config.sync_enabled) {
        try {
          // If we have a root directory URL, add it to tracked handles
          if (snapshot.rootDirectoryUrl) {
            const rootDirUrl = snapshot.rootDirectoryUrl;
            const rootHandle = await this.repo.find<DirectoryDocument>(
              rootDirUrl
            );
            this.handlesByPath.set("", rootHandle);
          }

          if (this.handlesByPath.size > 0) {
            // Sort handles leaf-first (deepest paths first, then shallower)
            const sortedHandles = this.sortHandlesLeafFirst();
            await waitForSync(
              sortedHandles,
              this.config.sync_server_storage_id
            );
          }

          // Wait for bidirectional sync to stabilize.
          // This polls document heads until they stop changing, which indicates
          // that both our outgoing changes and any incoming peer changes have
          // been received.
          await waitForBidirectionalSync(
            this.repo,
            snapshot.rootDirectoryUrl,
            this.config.sync_server_storage_id,
            {
              timeoutMs: BIDIRECTIONAL_SYNC_TIMEOUT_MS,
              pollIntervalMs: 100,
              stableChecksRequired: 3,
            }
          );
        } catch (error) {
          out.taskLine(`Network sync failed: ${error}`, true);
          result.warnings.push(`Network sync failed: ${error}`);
        }
      }

      // Re-detect changes after network sync for fresh state
      const freshChanges = await this.changeDetector.detectChanges(snapshot);
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

      // Update snapshot heads after pulling remote changes
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
          // Handle might not exist if directory was deleted
        }
      }

      // Touch root directory if any changes were made during sync
      const hasChanges =
        result.filesChanged > 0 || result.directoriesChanged > 0;
      if (hasChanges) {
        await this.touchRootDirectory(snapshot);
      }

      // Save updated snapshot if not dry run
      await this.snapshotManager.save(snapshot);

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

    // Check for null (empty string/Uint8Array are valid content)
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
        // Use versioned URL (includes heads) so clients fetch correct version
        const versionedUrl = this.getVersionedUrl(handle);
        await this.addFileToDirectory(snapshot, change.path, versionedUrl);

        this.snapshotManager.updateFileEntry(snapshot, change.path, {
          path: joinAndNormalizePath(this.rootPath, change.path),
          url: versionedUrl,
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
    const localPath = joinAndNormalizePath(this.rootPath, change.path);

    if (!change.remoteHead) {
      throw new Error(
        `No remote head found for remote change to ${change.path}`
      );
    }

    // Check for null (empty string/Uint8Array are valid content)
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
            // Get versioned URL from handle (includes heads)
            const fileHandle = await this.repo.find<FileDocument>(fileEntry.url);
            const versionedUrl = this.getVersionedUrl(fileHandle);
            this.snapshotManager.updateFileEntry(snapshot, change.path, {
              path: localPath,
              url: versionedUrl,
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

    // 2) Ensure destination directory document exists
    await this.ensureDirectoryDocument(snapshot, toDirPath);

    // 3) Update the FileDocument name and content to match new location/state
    try {
      // Use plain URL for mutable handle
      const handle = await this.repo.find<FileDocument>(
        getPlainUrl(fromEntry.url)
      );
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

      // Get versioned URL after changes (includes current heads)
      const versionedUrl = this.getVersionedUrl(handle);

      // 4) Add file entry to destination directory with versioned URL
      await this.addFileToDirectory(snapshot, move.toPath, versionedUrl);

      // Track file handle for network sync
      this.handlesByPath.set(move.toPath, handle);

      // 5) Update snapshot entries
      this.snapshotManager.removeFileEntry(snapshot, move.fromPath);
      this.snapshotManager.updateFileEntry(snapshot, move.toPath, {
        ...fromEntry,
        path: joinAndNormalizePath(this.rootPath, move.toPath),
        url: versionedUrl,
        head: handle.heads(),
      });
    } catch (e) {
      // Failed to update file name - file may have been deleted
      out.taskLine(
        `Warning: Failed to rename ${move.fromPath} to ${move.toPath}`,
        true
      );
    }
  }

  /**
   * Create new remote file document
   */
  private async createRemoteFile(
    change: DetectedChange
  ): Promise<DocHandle<FileDocument> | null> {
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
    this.handlesByPath.set(change.path, handle);

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
    // Use plain URL for mutable handle
    const handle = await this.repo.find<FileDocument>(getPlainUrl(url));

    // Check if content actually changed before tracking for sync
    const doc = await handle.doc();
    const currentContent = doc?.content;
    const contentChanged = !isContentEqual(content, currentContent);

    // Update snapshot heads even when content is identical
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
    this.handlesByPath.set(filePath, handle);
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
    // Use plain URL for mutable handle
    const handle = await this.repo.find<FileDocument>(getPlainUrl(url));
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

    // Use plain URL for mutable handle
    const dirHandle = await this.repo.find<DirectoryDocument>(
      getPlainUrl(parentDirUrl)
    );

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
    // Always track the directory (even if unchanged) for proper leaf-first sync ordering
    this.handlesByPath.set(directoryPath, dirHandle);
    
    if (didChange && snapshotEntry) {
      snapshotEntry.head = dirHandle.heads();
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

            // Track discovered directory for sync
            this.handlesByPath.set(directoryPath, childDirHandle);

            // Get versioned URL for storage (includes current heads)
            const versionedUrl = this.getVersionedUrl(childDirHandle);

            // Update snapshot with discovered directory using versioned URL
            this.snapshotManager.updateDirectoryEntry(snapshot, directoryPath, {
              path: joinAndNormalizePath(this.rootPath, directoryPath),
              url: versionedUrl,
              head: childDirHandle.heads(),
              entries: [],
            });

            // Return versioned URL (callers use getPlainUrl() when they need to modify)
            return versionedUrl;
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

    // Get versioned URL for the new directory (includes heads)
    const versionedDirUrl = this.getVersionedUrl(dirHandle);

    // Add this directory to its parent
    // Use plain URL for mutable handle
    const parentHandle = await this.repo.find<DirectoryDocument>(
      getPlainUrl(parentDirUrl)
    );

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
          url: versionedDirUrl,
        });
        didChange = true;
      }
    });

    // Track directory handles for sync
    this.handlesByPath.set(directoryPath, dirHandle);
    if (didChange) {
      this.handlesByPath.set(parentPath, parentHandle);

      const parentSnapshotEntry = snapshot.directories.get(parentPath);
      if (parentSnapshotEntry) {
        parentSnapshotEntry.head = parentHandle.heads();
      }
    }

    // Update snapshot with new directory (use versioned URL for storage)
    this.snapshotManager.updateDirectoryEntry(snapshot, directoryPath, {
      path: joinAndNormalizePath(this.rootPath, directoryPath),
      url: versionedDirUrl,
      head: dirHandle.heads(),
      entries: [],
    });

    // Return versioned URL (callers use getPlainUrl() when they need to modify)
    return versionedDirUrl;
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
      // Use plain URL for mutable handle
      const dirHandle = await this.repo.find<DirectoryDocument>(
        getPlainUrl(parentDirUrl)
      );

      // Track this handle for network sync waiting
      this.handlesByPath.set(directoryPath, dirHandle);
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

      if (didChange && snapshotEntry) {
        snapshotEntry.head = dirHandle.heads();
      }
    } catch (error) {
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
      this.handlesByPath.set("", rootHandle);

      if (snapshotEntry) {
        snapshotEntry.head = rootHandle.heads();
      }
    } catch (error) {
      // Failed to update root directory timestamp
    }
  }

  /**
   * Sort tracked handles leaf-first (deepest paths first).
   * Returns handles in sorted order, logging URLs with heads for debugging.
   */
  private sortHandlesLeafFirst(): DocHandle<unknown>[] {
    // Sort paths by depth (descending - deepest first), then alphabetically
    const sortedPaths = Array.from(this.handlesByPath.keys()).sort((a, b) => {
      const depthA = a ? a.split("/").length : 0;
      const depthB = b ? b.split("/").length : 0;

      // Deepest first
      if (depthA !== depthB) {
        return depthB - depthA;
      }

      // Alphabetically by path
      return a.localeCompare(b);
    });

    // Log the sync order with versioned URLs for debugging (keep on complete)
    const handles: DocHandle<unknown>[] = [];
    for (const path of sortedPaths) {
      const handle = this.handlesByPath.get(path)!;
      const versionedUrl = this.getVersionedUrl(handle);
      out.taskLine(`Sync: ${path || "(root)"} -> ${versionedUrl}`, true);
      handles.push(handle);
    }

    return handles;
  }

  /**
   * Update all URLs (files and directories) in directory documents with current heads.
   *
   * This MUST be called AFTER all changes are applied but BEFORE network sync.
   * The problem it solves:
   * 1. When we create/update a file or directory and store its URL, the URL captures
   *    the heads at that moment
   * 2. Later operations may advance the document's heads
   * 3. But the URL stored in the parent directory has stale heads
   * 4. Clients reading the directory would get old views of entries
   *
   * The fix: walk leaf-first and update all entry URLs with current heads,
   * AFTER all changes have been applied. This ensures clients get consistent,
   * up-to-date versioned URLs.
   */
  private async updateDirectoryUrlsLeafFirst(
    snapshot: SyncSnapshot
  ): Promise<void> {
    // First, update file URLs in their parent directories
    await this.updateFileUrlsInDirectories(snapshot);

    // Then, update directory URLs in their parent directories (leaf-first)
    await this.updateSubdirectoryUrls(snapshot);
  }

  /**
   * Update file URLs in directory documents with current heads.
   */
  private async updateFileUrlsInDirectories(
    snapshot: SyncSnapshot
  ): Promise<void> {
    // Group files by their parent directory
    const filesByDir = new Map<string, string[]>();

    for (const filePath of snapshot.files.keys()) {
      const pathParts = filePath.split("/");
      pathParts.pop(); // Remove filename
      const dirPath = pathParts.join("/");

      if (!filesByDir.has(dirPath)) {
        filesByDir.set(dirPath, []);
      }
      filesByDir.get(dirPath)!.push(filePath);
    }

    // Process each directory that has files
    for (const [dirPath, filePaths] of filesByDir.entries()) {
      try {
        // Get the directory URL
        let dirUrl: AutomergeUrl;
        if (!dirPath || dirPath === "") {
          if (!snapshot.rootDirectoryUrl) continue;
          dirUrl = snapshot.rootDirectoryUrl;
        } else {
          const dirEntry = snapshot.directories.get(dirPath);
          if (!dirEntry) continue;
          dirUrl = dirEntry.url;
        }

        // Get directory handle
        const dirHandle = await this.repo.find<DirectoryDocument>(
          getPlainUrl(dirUrl)
        );

        // Get current heads for changeAt
        const snapshotEntry = snapshot.directories.get(dirPath);
        const heads = snapshotEntry?.head;

        // Build a map of file names to their current versioned URLs
        const fileUrlUpdates = new Map<string, AutomergeUrl>();

        for (const filePath of filePaths) {
          const fileEntry = snapshot.files.get(filePath);
          if (!fileEntry) continue;

          // Get current handle for this file
          const fileHandle = await this.repo.find<FileDocument>(
            getPlainUrl(fileEntry.url)
          );

          // Get versioned URL with current heads
          const currentVersionedUrl = this.getVersionedUrl(fileHandle);

          // Update snapshot entry
          snapshot.files.set(filePath, {
            ...fileEntry,
            url: currentVersionedUrl,
            head: fileHandle.heads(),
          });

          // Store for directory update
          const fileName = filePath.split("/").pop() || "";
          fileUrlUpdates.set(fileName, currentVersionedUrl);
        }

        // Update all file entries in the directory document
        let didChange = false;
        if (heads) {
          dirHandle.changeAt(heads, (doc: DirectoryDocument) => {
            for (const [fileName, newUrl] of fileUrlUpdates) {
              const existingIndex = doc.docs.findIndex(
                (entry) => entry.name === fileName && entry.type === "file"
              );
              if (existingIndex !== -1 && doc.docs[existingIndex].url !== newUrl) {
                doc.docs[existingIndex].url = newUrl;
                didChange = true;
              }
            }
          });
        } else {
          dirHandle.change((doc: DirectoryDocument) => {
            for (const [fileName, newUrl] of fileUrlUpdates) {
              const existingIndex = doc.docs.findIndex(
                (entry) => entry.name === fileName && entry.type === "file"
              );
              if (existingIndex !== -1 && doc.docs[existingIndex].url !== newUrl) {
                doc.docs[existingIndex].url = newUrl;
                didChange = true;
              }
            }
          });
        }

        // Track directory and update heads
        if (didChange) {
          this.handlesByPath.set(dirPath, dirHandle);
          if (snapshotEntry) {
            snapshotEntry.head = dirHandle.heads();
          }
        }
      } catch (error) {
        out.taskLine(
          `Warning: Failed to update file URLs in directory ${dirPath}`,
          true
        );
      }
    }
  }

  /**
   * Update subdirectory URLs in parent directories with current heads.
   * Processes leaf-first (deepest directories first).
   */
  private async updateSubdirectoryUrls(snapshot: SyncSnapshot): Promise<void> {
    // Get all directory paths and sort leaf-first (deepest first)
    const directoryPaths = Array.from(snapshot.directories.keys()).sort(
      (a, b) => {
        const depthA = a ? a.split("/").length : 0;
        const depthB = b ? b.split("/").length : 0;

        // Deepest first
        if (depthA !== depthB) {
          return depthB - depthA;
        }

        // Alphabetically by path
        return a.localeCompare(b);
      }
    );

    // Update each directory's URL in its parent
    for (const dirPath of directoryPaths) {
      // Skip root directory (has no parent)
      if (!dirPath || dirPath === "") {
        continue;
      }

      const dirEntry = snapshot.directories.get(dirPath);
      if (!dirEntry) continue;

      try {
        // Get current handle for this directory (use plain URL to get mutable handle)
        const dirHandle = await this.repo.find<DirectoryDocument>(
          getPlainUrl(dirEntry.url)
        );

        // Get versioned URL with CURRENT heads (after all children populated)
        const currentVersionedUrl = this.getVersionedUrl(dirHandle);

        // Update snapshot entry with current heads and versioned URL
        snapshot.directories.set(dirPath, {
          ...dirEntry,
          url: currentVersionedUrl,
          head: dirHandle.heads(),
        });

        // Get parent path
        const pathParts = dirPath.split("/");
        const dirName = pathParts.pop() || "";
        const parentPath = pathParts.join("/");

        // Get parent directory handle
        let parentDirUrl: AutomergeUrl;
        if (!parentPath || parentPath === "") {
          // Parent is root
          if (!snapshot.rootDirectoryUrl) continue;
          parentDirUrl = snapshot.rootDirectoryUrl;
        } else {
          const parentEntry = snapshot.directories.get(parentPath);
          if (!parentEntry) continue;
          parentDirUrl = parentEntry.url;
        }

        // Update the directory entry in the parent with the new versioned URL
        const parentHandle = await this.repo.find<DirectoryDocument>(
          getPlainUrl(parentDirUrl)
        );

        // Get parent's current heads for changeAt
        const parentSnapshotEntry =
          parentPath === ""
            ? snapshot.directories.get("")
            : snapshot.directories.get(parentPath);
        const parentHeads = parentSnapshotEntry?.head;

        let didChange = false;
        if (parentHeads) {
          parentHandle.changeAt(parentHeads, (doc: DirectoryDocument) => {
            const existingIndex = doc.docs.findIndex(
              (entry) => entry.name === dirName && entry.type === "folder"
            );
            if (existingIndex !== -1) {
              // Update the URL with current versioned URL
              doc.docs[existingIndex].url = currentVersionedUrl;
              didChange = true;
            }
          });
        } else {
          parentHandle.change((doc: DirectoryDocument) => {
            const existingIndex = doc.docs.findIndex(
              (entry) => entry.name === dirName && entry.type === "folder"
            );
            if (existingIndex !== -1) {
              // Update the URL with current versioned URL
              doc.docs[existingIndex].url = currentVersionedUrl;
              didChange = true;
            }
          });
        }

        // Track parent for sync and update its heads in snapshot
        if (didChange) {
          this.handlesByPath.set(parentPath, parentHandle);
          if (parentSnapshotEntry) {
            parentSnapshotEntry.head = parentHandle.heads();
          }
        }
      } catch (error) {
        out.taskLine(
          `Warning: Failed to update directory URL for ${dirPath}`,
          true
        );
      }
    }
  }
}
