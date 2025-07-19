import { AutomergeUrl, Repo, UrlHeads } from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";
import {
  ChangeType,
  FileType,
  SyncSnapshot,
  SnapshotFileEntry,
  SnapshotDirectoryEntry,
  FileDocument,
  DirectoryDocument,
} from "../types";
import {
  readFileContent,
  getFileSystemEntry,
  listDirectory,
  getRelativePath,
  normalizePath,
} from "../utils";

// Re-export ChangeType for other modules
export { ChangeType } from "../types";

/**
 * Represents a detected change
 */
export interface DetectedChange {
  path: string;
  changeType: ChangeType;
  fileType: FileType;
  localContent: string | Uint8Array | null;
  remoteContent: string | Uint8Array | null;
  localHead?: UrlHeads;
  remoteHead?: UrlHeads;
}

/**
 * Change detection engine
 */
export class ChangeDetector {
  constructor(
    private repo: Repo,
    private rootPath: string,
    private excludePatterns: string[] = []
  ) {}

  /**
   * Detect all changes between local filesystem and snapshot
   */
  async detectChanges(snapshot: SyncSnapshot): Promise<DetectedChange[]> {
    const changes: DetectedChange[] = [];

    // Get current filesystem state
    const currentFiles = await this.getCurrentFilesystemState();

    // Check for local changes (new, modified, deleted files)
    const localChanges = await this.detectLocalChanges(snapshot, currentFiles);
    changes.push(...localChanges);

    // Check for remote changes (changes in Automerge documents)
    const remoteChanges = await this.detectRemoteChanges(snapshot);
    changes.push(...remoteChanges);

    // Check for new remote documents not in snapshot (critical for clone scenarios)
    const newRemoteDocuments = await this.detectNewRemoteDocuments(snapshot);
    changes.push(...newRemoteDocuments);

    return changes;
  }

  /**
   * Detect changes in local filesystem compared to snapshot
   */
  private async detectLocalChanges(
    snapshot: SyncSnapshot,
    currentFiles: Map<string, { content: string | Uint8Array; type: FileType }>
  ): Promise<DetectedChange[]> {
    const changes: DetectedChange[] = [];

    // Check for new and modified files
    for (const [relativePath, fileInfo] of currentFiles.entries()) {
      const snapshotEntry = snapshot.files.get(relativePath);

      if (!snapshotEntry) {
        // New file
        changes.push({
          path: relativePath,
          changeType: ChangeType.LOCAL_ONLY,
          fileType: fileInfo.type,
          localContent: fileInfo.content,
          remoteContent: null,
        });
      } else {
        // Check if content changed
        const lastKnownContent = await this.getContentAtHead(
          snapshotEntry.url,
          snapshotEntry.head
        );
        const contentChanged = !this.isContentEqual(
          fileInfo.content,
          lastKnownContent
        );

        if (contentChanged) {
          // Check remote state too
          const currentRemoteContent = await this.getCurrentRemoteContent(
            snapshotEntry.url
          );
          const remoteChanged = !this.isContentEqual(
            lastKnownContent,
            currentRemoteContent
          );

          const changeType = remoteChanged
            ? ChangeType.BOTH_CHANGED
            : ChangeType.LOCAL_ONLY;

          changes.push({
            path: relativePath,
            changeType,
            fileType: fileInfo.type,
            localContent: fileInfo.content,
            remoteContent: currentRemoteContent,
            localHead: snapshotEntry.head,
            remoteHead: await this.getCurrentRemoteHead(snapshotEntry.url),
          });
        }
      }
    }

    // Check for deleted files
    for (const [relativePath, snapshotEntry] of snapshot.files.entries()) {
      if (!currentFiles.has(relativePath)) {
        // File was deleted locally
        const currentRemoteContent = await this.getCurrentRemoteContent(
          snapshotEntry.url
        );
        const lastKnownContent = await this.getContentAtHead(
          snapshotEntry.url,
          snapshotEntry.head
        );
        const remoteChanged = !this.isContentEqual(
          lastKnownContent,
          currentRemoteContent
        );

        const changeType = remoteChanged
          ? ChangeType.BOTH_CHANGED
          : ChangeType.LOCAL_ONLY;

        changes.push({
          path: relativePath,
          changeType,
          fileType: FileType.TEXT, // Will be determined from document
          localContent: null,
          remoteContent: currentRemoteContent,
          localHead: snapshotEntry.head,
          remoteHead: await this.getCurrentRemoteHead(snapshotEntry.url),
        });
      }
    }

    return changes;
  }

  /**
   * Detect changes in remote Automerge documents compared to snapshot
   */
  private async detectRemoteChanges(
    snapshot: SyncSnapshot
  ): Promise<DetectedChange[]> {
    const changes: DetectedChange[] = [];

    for (const [relativePath, snapshotEntry] of snapshot.files.entries()) {
      const currentRemoteHead = await this.getCurrentRemoteHead(
        snapshotEntry.url
      );

      if (currentRemoteHead !== snapshotEntry.head) {
        // Remote document has changed
        const currentRemoteContent = await this.getCurrentRemoteContent(
          snapshotEntry.url
        );
        const localContent = await this.getLocalContent(relativePath);
        const lastKnownContent = await this.getContentAtHead(
          snapshotEntry.url,
          snapshotEntry.head
        );

        const localChanged = localContent
          ? !this.isContentEqual(localContent, lastKnownContent)
          : false;

        const changeType = localChanged
          ? ChangeType.BOTH_CHANGED
          : ChangeType.REMOTE_ONLY;

        changes.push({
          path: relativePath,
          changeType,
          fileType: await this.getFileTypeFromContent(currentRemoteContent),
          localContent,
          remoteContent: currentRemoteContent,
          localHead: snapshotEntry.head,
          remoteHead: currentRemoteHead,
        });
      }
    }

    return changes;
  }

  /**
   * Detect new remote documents from directory hierarchy that aren't in snapshot
   * This is critical for clone scenarios where local snapshot is empty
   */
  private async detectNewRemoteDocuments(
    snapshot: SyncSnapshot
  ): Promise<DetectedChange[]> {
    const changes: DetectedChange[] = [];

    // If no root directory URL, nothing to discover
    if (!snapshot.rootDirectoryUrl) {
      return changes;
    }

    try {
      // Recursively traverse the directory hierarchy
      await this.discoverRemoteDocumentsRecursive(
        snapshot.rootDirectoryUrl,
        "",
        snapshot,
        changes
      );
    } catch (error) {
      console.warn(`❌ Failed to discover remote documents: ${error}`);
    }

    return changes;
  }

  /**
   * Recursively discover remote documents in directory hierarchy
   */
  private async discoverRemoteDocumentsRecursive(
    directoryUrl: AutomergeUrl,
    currentPath: string,
    snapshot: SyncSnapshot,
    changes: DetectedChange[]
  ): Promise<void> {
    try {
      const dirHandle = await this.repo.find<DirectoryDocument>(directoryUrl);
      const dirDoc = await dirHandle.doc();

      if (!dirDoc) {
        return;
      }

      // Process each entry in the directory
      for (const entry of dirDoc.docs) {
        const entryPath = currentPath
          ? `${currentPath}/${entry.name}`
          : entry.name;

        if (entry.type === "file") {
          // Check if this file is already tracked in the snapshot
          const existingEntry = Array.from(snapshot.files.values()).find(
            (snapshotEntry) => snapshotEntry.url === entry.url
          );

          if (!existingEntry) {
            // This is a new remote file not in our snapshot
            const remoteContent = await this.getCurrentRemoteContent(entry.url);
            const localContent = await this.getLocalContent(entryPath);

            // Determine if there's a local file with the same path
            const changeType = localContent
              ? ChangeType.BOTH_CHANGED
              : ChangeType.REMOTE_ONLY;

            changes.push({
              path: entryPath,
              changeType,
              fileType: await this.getFileTypeFromContent(remoteContent),
              localContent,
              remoteContent,
              remoteHead: await this.getCurrentRemoteHead(entry.url),
            });
          }
        } else if (entry.type === "folder") {
          // Recursively process subdirectory
          await this.discoverRemoteDocumentsRecursive(
            entry.url,
            entryPath,
            snapshot,
            changes
          );
        }
      }
    } catch (error) {
      console.warn(`❌ Failed to process directory ${currentPath}: ${error}`);
    }
  }

  /**
   * Get current filesystem state as a map
   */
  private async getCurrentFilesystemState(): Promise<
    Map<string, { content: string | Uint8Array; type: FileType }>
  > {
    const fileMap = new Map<
      string,
      { content: string | Uint8Array; type: FileType }
    >();

    try {
      const entries = await listDirectory(
        this.rootPath,
        true,
        this.excludePatterns
      );

      for (const entry of entries) {
        if (entry.type !== FileType.DIRECTORY) {
          const relativePath = getRelativePath(this.rootPath, entry.path);
          const content = await readFileContent(entry.path);

          fileMap.set(relativePath, {
            content,
            type: entry.type,
          });
        }
      }
    } catch (error) {
      console.warn(`Failed to scan filesystem: ${error}`);
    }

    return fileMap;
  }

  /**
   * Get local file content if it exists
   */
  private async getLocalContent(
    relativePath: string
  ): Promise<string | Uint8Array | null> {
    try {
      const fullPath = normalizePath(this.rootPath + "/" + relativePath);
      return await readFileContent(fullPath);
    } catch {
      return null;
    }
  }

  /**
   * Get content from Automerge document at specific head
   */
  private async getContentAtHead(
    url: AutomergeUrl,
    heads: UrlHeads
  ): Promise<string | Uint8Array | null> {
    const handle = await this.repo.find<FileDocument>(url);
    const doc = await handle.view(heads).doc();
    return doc?.contents as string | Uint8Array;
  }

  /**
   * Get current content from Automerge document
   */
  private async getCurrentRemoteContent(
    url: AutomergeUrl
  ): Promise<string | Uint8Array | null> {
    try {
      const handle = await this.repo.find<FileDocument>(url);
      const doc = await handle.doc();

      if (!doc) return null;

      const fileDoc = doc as FileDocument;
      return fileDoc.contents as string | Uint8Array;
    } catch (error) {
      console.warn(
        `❌ Failed to get current remote content for ${url}: ${error}`
      );
      return null;
    }
  }

  /**
   * Get current head of Automerge document
   */
  private async getCurrentRemoteHead(url: AutomergeUrl): Promise<UrlHeads> {
    return (await this.repo.find<FileDocument>(url)).heads();
  }

  /**
   * Determine file type from content
   */
  private async getFileTypeFromContent(
    content: string | Uint8Array | null
  ): Promise<FileType> {
    if (!content) return FileType.TEXT;

    if (content instanceof Uint8Array) {
      return FileType.BINARY;
    } else {
      return FileType.TEXT;
    }
  }

  /**
   * Compare two content pieces for equality
   */
  private isContentEqual(
    content1: string | Uint8Array | null,
    content2: string | Uint8Array | null
  ): boolean {
    if (content1 === content2) return true;
    if (!content1 || !content2) return false;

    if (typeof content1 !== typeof content2) return false;

    if (typeof content1 === "string") {
      return content1 === content2;
    } else {
      // Compare Uint8Array
      const buf1 = content1 as Uint8Array;
      const buf2 = content2 as Uint8Array;

      if (buf1.length !== buf2.length) return false;

      for (let i = 0; i < buf1.length; i++) {
        if (buf1[i] !== buf2[i]) return false;
      }

      return true;
    }
  }

  /**
   * Classify change type for a path
   */
  async classifyChange(
    relativePath: string,
    snapshot: SyncSnapshot
  ): Promise<ChangeType> {
    const snapshotEntry = snapshot.files.get(relativePath);
    const localContent = await this.getLocalContent(relativePath);

    if (!snapshotEntry) {
      // New file
      return ChangeType.LOCAL_ONLY;
    }

    const lastKnownContent = await this.getContentAtHead(
      snapshotEntry.url,
      snapshotEntry.head
    );
    const currentRemoteContent = await this.getCurrentRemoteContent(
      snapshotEntry.url
    );

    const localChanged = localContent
      ? !this.isContentEqual(localContent, lastKnownContent)
      : true;
    const remoteChanged = !this.isContentEqual(
      lastKnownContent,
      currentRemoteContent
    );

    if (!localChanged && !remoteChanged) {
      return ChangeType.NO_CHANGE;
    } else if (localChanged && !remoteChanged) {
      return ChangeType.LOCAL_ONLY;
    } else if (!localChanged && remoteChanged) {
      return ChangeType.REMOTE_ONLY;
    } else {
      return ChangeType.BOTH_CHANGED;
    }
  }
}
