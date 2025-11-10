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
import { span, spanSync, attr } from "../tracing";
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
    const currentFiles = await span(
      "scan_filesystem",
      (async () => {
        const files = await this.getCurrentFilesystemState();
        return files;
      })()
    );
    attr("file_count", currentFiles.size);

    // Check for local changes (new, modified, deleted files)
    const localChanges = await span(
      "check_local",
      (async () => {
        const changes = await this.detectLocalChanges(snapshot, currentFiles);
        return changes;
      })()
    );
    attr("local_change_count", localChanges.length);
    changes.push(...localChanges);

    // Check for remote changes (changes in Automerge documents)
    const remoteChanges = await span(
      "check_remote",
      (async () => {
        const changes = await this.detectRemoteChanges(snapshot);
        return changes;
      })()
    );
    attr("remote_change_count", remoteChanges.length);
    changes.push(...remoteChanges);

    // Check for new remote documents not in snapshot (critical for clone scenarios)
    const newRemoteDocuments = await span(
      "check_new_remote",
      (async () => {
        const changes = await this.detectNewRemoteDocuments(snapshot);
        return changes;
      })()
    );
    attr("new_remote_count", newRemoteDocuments.length);
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
    let fileIndex = 0;
    for (const [relativePath, fileInfo] of currentFiles.entries()) {
      await span(
        `check_file_${fileIndex++}_${relativePath.replace(/\//g, "_")}`,
        (async () => {
          const snapshotEntry = snapshot.files.get(relativePath);

          if (!snapshotEntry) {
            // New file
            attr("status", "new");
            changes.push({
              path: relativePath,
              changeType: ChangeType.LOCAL_ONLY,
              fileType: fileInfo.type,
              localContent: fileInfo.content,
              remoteContent: null,
            });
          } else {
            // Check if content changed - instrument expensive operations
            const lastKnownContent = await span(
              "get_content_at_head",
              this.getContentAtHead(snapshotEntry.url, snapshotEntry.head)
            );

            const contentChanged = spanSync(
              "compare_local_content",
              () => !this.isContentEqual(fileInfo.content, lastKnownContent)
            );
            attr("content_changed", contentChanged);

            if (contentChanged) {
              // Check remote state too - instrument expensive operations
              const currentRemoteContent = await span(
                "get_current_remote_content",
                this.getCurrentRemoteContent(snapshotEntry.url)
              );

              const remoteChanged = spanSync(
                "compare_remote_content",
                () =>
                  !this.isContentEqual(lastKnownContent, currentRemoteContent)
              );
              attr("remote_changed", remoteChanged);

              const changeType = remoteChanged
                ? ChangeType.BOTH_CHANGED
                : ChangeType.LOCAL_ONLY;
              attr("change_type", changeType);

              const remoteHead = await span(
                "get_current_remote_head",
                this.getCurrentRemoteHead(snapshotEntry.url)
              );

              changes.push({
                path: relativePath,
                changeType,
                fileType: fileInfo.type,
                localContent: fileInfo.content,
                remoteContent: currentRemoteContent,
                localHead: snapshotEntry.head,
                remoteHead,
              });
            } else {
              attr("status", "unchanged");
            }
          }
        })()
      );
    }

    // Check for deleted files
    let deletedIndex = 0;
    for (const [relativePath, snapshotEntry] of snapshot.files.entries()) {
      if (!currentFiles.has(relativePath)) {
        await span(
          `check_deleted_${deletedIndex++}_${relativePath.replace(/\//g, "_")}`,
          (async () => {
            // File was deleted locally
            const currentRemoteContent = await span(
              "get_current_remote_content",
              this.getCurrentRemoteContent(snapshotEntry.url)
            );
            const lastKnownContent = await span(
              "get_content_at_head",
              this.getContentAtHead(snapshotEntry.url, snapshotEntry.head)
            );

            const remoteChanged = spanSync(
              "compare_remote_content",
              () => !this.isContentEqual(lastKnownContent, currentRemoteContent)
            );
            attr("remote_changed", remoteChanged);

            const changeType = remoteChanged
              ? ChangeType.BOTH_CHANGED
              : ChangeType.LOCAL_ONLY;
            attr("change_type", changeType);

            changes.push({
              path: relativePath,
              changeType,
              fileType: FileType.TEXT, // Will be determined from document
              localContent: null,
              remoteContent: currentRemoteContent,
              localHead: snapshotEntry.head,
              remoteHead: await span(
                "get_current_remote_head",
                this.getCurrentRemoteHead(snapshotEntry.url)
              ),
            });
          })(),
          { path: relativePath, status: "deleted_locally" }
        );
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
      // CRITICAL FIX: Check if file still exists in remote directory listing
      // Files can be removed from the directory without their document heads changing
      const stillExistsInDirectory = await this.fileExistsInRemoteDirectory(
        snapshot.rootDirectoryUrl,
        relativePath
      );

      if (!stillExistsInDirectory) {
        // File was removed from remote directory listing
        const localContent = await this.getLocalContent(relativePath);

        // Only report as deleted if local file still exists
        // (if local file is also deleted, detectLocalChanges handles it)
        if (localContent !== null) {
          changes.push({
            path: relativePath,
            changeType: ChangeType.REMOTE_ONLY,
            fileType: FileType.TEXT,
            localContent,
            remoteContent: null, // File deleted remotely
            localHead: snapshotEntry.head,
            remoteHead: snapshotEntry.head,
          });
        }
        continue;
      }

      const currentRemoteHead = await this.getCurrentRemoteHead(
        snapshotEntry.url
      );

      if (!A.equals(currentRemoteHead, snapshotEntry.head)) {
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
          const existingEntry = snapshot.files.get(entryPath);

          if (!existingEntry) {
            // This is a remote file not in our snapshot
            const localContent = await this.getLocalContent(entryPath);
            const remoteContent = await this.getCurrentRemoteContent(entry.url);
            const remoteHead = await this.getCurrentRemoteHead(entry.url);

            if (localContent && remoteContent) {
              // File exists both locally and remotely but not in snapshot
              changes.push({
                path: entryPath,
                changeType: ChangeType.BOTH_CHANGED,
                fileType: await this.getFileTypeFromContent(remoteContent),
                localContent,
                remoteContent,
                remoteHead,
              });
            } else if (localContent !== null && remoteContent === null) {
              // File exists locally but not remotely (shouldn't happen in this flow)
              changes.push({
                path: entryPath,
                changeType: ChangeType.LOCAL_ONLY,
                fileType: await this.getFileTypeFromContent(localContent),
                localContent,
                remoteContent: null,
              });
            } else if (localContent === null && remoteContent !== null) {
              // File exists remotely but not locally - this is what we need for clone!
              changes.push({
                path: entryPath,
                changeType: ChangeType.REMOTE_ONLY,
                fileType: await this.getFileTypeFromContent(remoteContent),
                localContent: null,
                remoteContent,
                remoteHead,
              });
            }
            // Only ignore if neither local nor remote content exists (ghost entry)
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
      const entries = await span(
        "list_directory",
        listDirectory(this.rootPath, true, this.excludePatterns)
      );

      await span(
        "read_all_files",
        (async () => {
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
        })()
      );
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
    const handle = await span("repo_find", this.repo.find<FileDocument>(url));

    const doc = await span("view_at_heads", handle.view(heads).doc());

    const content = (doc as FileDocument | undefined)?.content;
    // Convert ImmutableString to regular string
    if (A.isImmutableString(content)) {
      return content.toString();
    }
    return content as string | Uint8Array;
  }

  /**
   * Get current content from Automerge document
   */
  private async getCurrentRemoteContent(
    url: AutomergeUrl
  ): Promise<string | Uint8Array | null> {
    try {
      const handle = await span("repo_find", this.repo.find<FileDocument>(url));

      const doc = await span("get_doc", handle.doc());

      if (!doc) return null;

      const fileDoc = doc as FileDocument;
      const content = fileDoc.content;
      // Convert ImmutableString to regular string
      if (A.isImmutableString(content)) {
        return content.toString();
      }
      return content as string | Uint8Array;
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
    const handle = await span("repo_find", this.repo.find<FileDocument>(url));
    return handle.heads();
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

  /**
   * Check if a file exists in the remote directory hierarchy
   */
  private async fileExistsInRemoteDirectory(
    rootDirectoryUrl: AutomergeUrl | undefined,
    filePath: string
  ): Promise<boolean> {
    if (!rootDirectoryUrl) return false;
    const entry = await this.findFileInDirectoryHierarchy(
      rootDirectoryUrl,
      filePath
    );
    return entry !== null;
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
}
