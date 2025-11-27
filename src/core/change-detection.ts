import { AutomergeUrl, Repo, UrlHeads } from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";
import {
  ChangeType,
  FileType,
  SyncSnapshot,
  FileDocument,
  DirectoryDocument,
  DetectedChange,
} from "../types";
import {
  readFileContent,
  listDirectory,
  getRelativePath,
  findFileInDirectoryHierarchy,
  joinAndNormalizePath,
} from "../utils";
import { isContentEqual } from "../utils/content";
import { out } from "../utils/output";

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

    // Check for new and modified files in parallel for better performance
    await Promise.all(
      Array.from(currentFiles.entries()).map(
        async ([relativePath, fileInfo]) => {
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

            const contentChanged = !isContentEqual(
              fileInfo.content,
              lastKnownContent
            );

            if (contentChanged) {
              // Check remote state too
              const currentRemoteContent = await this.getCurrentRemoteContent(
                snapshotEntry.url
              );

              const remoteChanged = !isContentEqual(
                lastKnownContent,
                currentRemoteContent
              );

              const changeType = remoteChanged
                ? ChangeType.BOTH_CHANGED
                : ChangeType.LOCAL_ONLY;

              const remoteHead = await this.getCurrentRemoteHead(
                snapshotEntry.url
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
            }
          }
        }
      )
    );

    // Check for deleted files in parallel
    await Promise.all(
      Array.from(snapshot.files.entries())
        .filter(([relativePath]) => !currentFiles.has(relativePath))
        .map(async ([relativePath, snapshotEntry]) => {
          // File was deleted locally
          const currentRemoteContent = await this.getCurrentRemoteContent(
            snapshotEntry.url
          );
          const lastKnownContent = await this.getContentAtHead(
            snapshotEntry.url,
            snapshotEntry.head
          );

          const remoteChanged = !isContentEqual(
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
        })
    );

    return changes;
  }

  /**
   * Detect changes in remote Automerge documents compared to snapshot
   */
  private async detectRemoteChanges(
    snapshot: SyncSnapshot
  ): Promise<DetectedChange[]> {
    const changes: DetectedChange[] = [];

    await Promise.all(
      Array.from(snapshot.files.entries()).map(
        async ([relativePath, snapshotEntry]) => {
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
            return;
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
              ? !isContentEqual(localContent, lastKnownContent)
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
      )
    );

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
      out.taskLine(`Failed to discover remote documents: ${error}`, true);
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
      out.taskLine(`Failed to process directory: ${error}`, true);
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

      const fileEntries = entries.filter(
        (entry) => entry.type !== FileType.DIRECTORY
      );

      await Promise.all(
        fileEntries.map(async (entry) => {
          const relativePath = getRelativePath(this.rootPath, entry.path);
          const content = await readFileContent(entry.path);

          fileMap.set(relativePath, {
            content,
            type: entry.type,
          });
        })
      );
    } catch (error) {
      out.taskLine(`Failed to scan filesystem: ${error}`, true);
      // Log more details about the error
      if (error instanceof Error) {
        out.taskLine(`Error details: ${error.message}`, true);
        if (error.stack) {
          out.taskLine(`Stack: ${error.stack}`, true);
        }
      }
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
      const fullPath = joinAndNormalizePath(this.rootPath, relativePath);
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
      const handle = await this.repo.find<FileDocument>(url);
      const doc = await handle.doc();

      if (!doc) return null;

      const fileDoc = doc as FileDocument;
      const content = fileDoc.content;
      // Convert ImmutableString to regular string
      if (A.isImmutableString(content)) {
        return content.toString();
      }
      return content as string | Uint8Array;
    } catch (error) {
      out.taskLine(`Failed to get remote content: ${error}`, true);
      return null;
    }
  }

  /**
   * Get current head of Automerge document
   */
  private async getCurrentRemoteHead(url: AutomergeUrl): Promise<UrlHeads> {
    const handle = await this.repo.find<FileDocument>(url);
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
      ? !isContentEqual(localContent, lastKnownContent)
      : true;
    const remoteChanged = !isContentEqual(
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
    const entry = await findFileInDirectoryHierarchy(
      this.repo,
      rootDirectoryUrl,
      filePath
    );
    return entry !== null;
  }
}
