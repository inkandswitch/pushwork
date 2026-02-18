import {
  DocHandle,
  StorageId,
  Repo,
  AutomergeUrl,
} from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";
import { out } from "./output";
import { DirectoryDocument } from "../types";
import { getPlainUrl } from "./directory";

const isDebug = !!process.env.DEBUG;
function debug(...args: any[]) {
  if (isDebug) console.error("[pushwork:sync]", ...args);
}

/**
 * Wait for bidirectional sync to stabilize.
 * This function waits until document heads stop changing, indicating that
 * both outgoing and incoming sync has completed.
 *
 * @param repo - The Automerge repository
 * @param rootDirectoryUrl - The root directory URL to start traversal from
 * @param syncServerStorageId - The sync server storage ID
 * @param options - Configuration options
 */
export async function waitForBidirectionalSync(
  repo: Repo,
  rootDirectoryUrl: AutomergeUrl | undefined,
  syncServerStorageId: StorageId | undefined,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    stableChecksRequired?: number;
    handles?: DocHandle<unknown>[];
  } = {},
): Promise<void> {
  const {
    timeoutMs = 10000,
    pollIntervalMs = 100,
    stableChecksRequired = 3,
    handles,
  } = options;

  if (!syncServerStorageId || !rootDirectoryUrl) {
    return;
  }

  const startTime = Date.now();
  let lastSeenHeads = new Map<string, string>();
  let stableCount = 0;
  let pollCount = 0;
  let dynamicTimeoutMs = timeoutMs;

  debug(`waitForBidirectionalSync: starting (timeout=${timeoutMs}ms, stableChecks=${stableChecksRequired}${handles ? `, tracking ${handles.length} handles` : ', full tree scan'})`);

  while (Date.now() - startTime < dynamicTimeoutMs) {
    pollCount++;
    // Get current heads: use provided handles if available, otherwise full tree scan
    const currentHeads = handles
      ? getHandleHeads(handles)
      : await getAllDocumentHeads(repo, rootDirectoryUrl);

    // Scale timeout proportionally to tree size after first scan
    if (pollCount === 1) {
      dynamicTimeoutMs = Math.max(timeoutMs, 5000 + currentHeads.size * 50);
      if (dynamicTimeoutMs !== timeoutMs) {
        debug(`waitForBidirectionalSync: scaled timeout to ${dynamicTimeoutMs}ms for ${currentHeads.size} docs`);
      }
    }

    // Check if heads are stable (no changes since last check)
    const isStable = headsMapEqual(lastSeenHeads, currentHeads);

    if (isStable) {
      stableCount++;
      debug(`waitForBidirectionalSync: stable check ${stableCount}/${stableChecksRequired} (${currentHeads.size} docs, poll #${pollCount})`);
      if (stableCount >= stableChecksRequired) {
        const elapsed = Date.now() - startTime;
        debug(`waitForBidirectionalSync: converged in ${elapsed}ms after ${pollCount} polls (${currentHeads.size} docs)`);
        out.taskLine(`Bidirectional sync converged (${currentHeads.size} docs, ${elapsed}ms)`);
        return; // Converged!
      }
    } else {
      // Find which docs changed
      if (lastSeenHeads.size > 0) {
        const changedDocs: string[] = [];
        for (const [url, heads] of currentHeads) {
          if (lastSeenHeads.get(url) !== heads) {
            changedDocs.push(url.slice(0, 20) + "...");
          }
        }
        const newDocs = currentHeads.size - lastSeenHeads.size;
        if (newDocs > 0) {
          debug(`waitForBidirectionalSync: ${newDocs} new docs discovered, ${changedDocs.length} docs changed heads (poll #${pollCount})`);
        } else if (changedDocs.length > 0) {
          debug(`waitForBidirectionalSync: ${changedDocs.length} docs changed heads: ${changedDocs.slice(0, 5).join(", ")}${changedDocs.length > 5 ? ` ...and ${changedDocs.length - 5} more` : ""} (poll #${pollCount})`);
        }
      } else {
        debug(`waitForBidirectionalSync: initial scan found ${currentHeads.size} docs (poll #${pollCount})`);
      }
      if (stableCount > 0) {
        debug(`waitForBidirectionalSync: heads changed after ${stableCount} stable checks, resetting`);
      }
      stableCount = 0;
      lastSeenHeads = currentHeads;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Timeout - but don't throw, just log a warning
  // The sync may still work, we just couldn't confirm stability
  const elapsed = Date.now() - startTime;
  debug(`waitForBidirectionalSync: timed out after ${elapsed}ms (${pollCount} polls, ${lastSeenHeads.size} docs tracked, reached ${stableCount}/${stableChecksRequired} stable checks)`);
  out.taskLine(`Bidirectional sync timed out after ${(elapsed / 1000).toFixed(1)}s - document heads were still changing after ${pollCount} checks across ${lastSeenHeads.size} docs (reached ${stableCount}/${stableChecksRequired} stability checks). This may mean another peer is actively editing, or the sync server is slow to relay changes. The sync will continue but some remote changes may not be reflected yet.`, true);
}

/**
 * Get heads from a pre-collected set of handles (cheap, synchronous reads).
 * Used for post-push stabilization where we already know which documents changed.
 */
function getHandleHeads(
  handles: DocHandle<unknown>[],
): Map<string, string> {
  const heads = new Map<string, string>();
  for (const handle of handles) {
    heads.set(getPlainUrl(handle.url), JSON.stringify(handle.heads()));
  }
  return heads;
}

/**
 * Get all document heads in the directory hierarchy.
 * Returns a map of document URL -> serialized heads.
 * Uses plain URLs (without heads) to ensure we see current document state.
 */
async function getAllDocumentHeads(
  repo: Repo,
  rootDirectoryUrl: AutomergeUrl,
): Promise<Map<string, string>> {
  const heads = new Map<string, string>();
  // Pass URL as-is; collectHeadsRecursive will strip heads
  await collectHeadsRecursive(repo, rootDirectoryUrl, heads);
  return heads;
}

/**
 * Recursively collect document heads from the directory hierarchy.
 * Uses getPlainUrl to strip heads and always see the CURRENT state of documents.
 */
async function collectHeadsRecursive(
  repo: Repo,
  directoryUrl: AutomergeUrl,
  heads: Map<string, string>,
): Promise<void> {
  try {
    const plainUrl = getPlainUrl(directoryUrl);
    const handle = await repo.find<DirectoryDocument>(plainUrl);
    const doc = await handle.doc();

    // Record this directory's heads (use plain URL as key for consistency)
    heads.set(plainUrl, JSON.stringify(handle.heads()));

    if (!doc || !doc.docs) {
      return;
    }

    // Process all entries in the directory concurrently
    await Promise.all(doc.docs.map(async (entry: { type: string; url: AutomergeUrl; name: string }) => {
      if (entry.type === "folder") {
        // Recurse into subdirectory (entry.url may have stale heads)
        await collectHeadsRecursive(repo, entry.url, heads);
      } else if (entry.type === "file") {
        // Get file document heads (strip heads from entry.url)
        try {
          const fileUrl = getPlainUrl(entry.url);
          const fileHandle = await repo.find(fileUrl);
          heads.set(fileUrl, JSON.stringify(fileHandle.heads()));
        } catch {
          // File document may not exist yet
        }
      }
    }));
  } catch {
    // Directory may not exist yet
  }
}

/**
 * Compare two heads maps for equality.
 */
function headsMapEqual(
  a: Map<string, string>,
  b: Map<string, string>,
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false;
    }
  }
  return true;
}

/**
 * Wait for documents to sync to the remote server
 */
export async function waitForSync(
  handlesToWaitOn: DocHandle<unknown>[],
  syncServerStorageId?: StorageId,
  timeoutMs: number = 60000,
): Promise<void> {
  const startTime = Date.now();

  if (!syncServerStorageId) {
    debug("waitForSync: no sync server storage ID, skipping");
    return;
  }

  if (handlesToWaitOn.length === 0) {
    debug("waitForSync: no documents to sync");
    return;
  }

  debug(`waitForSync: waiting for ${handlesToWaitOn.length} documents (timeout=${timeoutMs}ms)`);

  let alreadySynced = 0;

  const promises = handlesToWaitOn.map((handle) => {
    // Check if already synced
    const heads = handle.heads();
    const syncInfo = handle.getSyncInfo(syncServerStorageId);
    const remoteHeads = syncInfo?.lastHeads;
    const wasAlreadySynced = A.equals(heads, remoteHeads);

    if (wasAlreadySynced) {
      alreadySynced++;
      debug(`waitForSync: ${handle.url.slice(0, 20)}... already synced`);
      return Promise.resolve();
    }

    debug(`waitForSync: ${handle.url.slice(0, 20)}... waiting for convergence (remoteHeads=${remoteHeads ? 'present' : 'missing'})`);

    // Wait for convergence
    return new Promise<void>((resolve, reject) => {
      let pollInterval: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(pollInterval);
        handle.off("remote-heads", onRemoteHeads);
      };

      const onConverged = () => {
        debug(`waitForSync: ${handle.url.slice(0, 20)}... converged in ${Date.now() - startTime}ms`);
        cleanup();
        resolve();
      };

      const timeout = setTimeout(() => {
        debug(`waitForSync: ${handle.url.slice(0, 20)}... timed out after ${timeoutMs}ms`);
        cleanup();
        reject(
          new Error(
            `Sync timeout after ${timeoutMs}ms for document ${handle.url}`,
          ),
        );
      }, timeoutMs);

      const isConverged = () => {
        const localHeads = handle.heads();
        const info = handle.getSyncInfo(syncServerStorageId);
        return A.equals(localHeads, info?.lastHeads);
      };

      const onRemoteHeads = ({
        storageId,
      }: {
        storageId: StorageId;
        heads: any;
      }) => {
        if (storageId === syncServerStorageId && isConverged()) {
          onConverged();
        }
      };

      const poll = () => {
        if (isConverged()) {
          onConverged();
          return true;
        }
        return false;
      };

      // Initial check
      if (poll()) {
        return;
      }

      // Start polling and event listening
      pollInterval = setInterval(() => {
        poll();
      }, 100);

      handle.on("remote-heads", onRemoteHeads);
    });
  });

  const needSync = handlesToWaitOn.length - alreadySynced;
  if (needSync > 0) {
    debug(`waitForSync: ${alreadySynced} already synced, waiting for ${needSync} remaining`);
    out.taskLine(`Uploading: ${alreadySynced}/${handlesToWaitOn.length} already synced, waiting for ${needSync} more`);
  } else {
    debug(`waitForSync: all ${handlesToWaitOn.length} already synced`);
  }

  try {
    await Promise.all(promises);
    const elapsed = Date.now() - startTime;
    debug(`waitForSync: all ${handlesToWaitOn.length} documents synced in ${elapsed}ms (${alreadySynced} were already synced)`);
    out.taskLine(`All ${handlesToWaitOn.length} documents uploaded to server (${(elapsed / 1000).toFixed(1)}s)`);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    debug(`waitForSync: failed after ${elapsed}ms: ${error}`);
    out.taskLine(`Upload to server failed after ${(elapsed / 1000).toFixed(1)}s: ${error}`, true);
    throw error;
  }
}
