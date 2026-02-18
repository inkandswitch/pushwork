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
  } = {},
): Promise<void> {
  const {
    timeoutMs = 10000,
    pollIntervalMs = 100,
    stableChecksRequired = 3,
  } = options;

  if (!syncServerStorageId || !rootDirectoryUrl) {
    return;
  }

  const startTime = Date.now();
  let lastSeenHeads = new Map<string, string>();
  let stableCount = 0;

  debug(`waitForBidirectionalSync: starting (timeout=${timeoutMs}ms, stableChecks=${stableChecksRequired})`);

  while (Date.now() - startTime < timeoutMs) {
    // Get current heads for all documents in the directory hierarchy
    const currentHeads = await getAllDocumentHeads(repo, rootDirectoryUrl);

    // Check if heads are stable (no changes since last check)
    const isStable = headsMapEqual(lastSeenHeads, currentHeads);

    if (isStable) {
      stableCount++;
      debug(`waitForBidirectionalSync: stable check ${stableCount}/${stableChecksRequired} (${currentHeads.size} docs)`);
      if (stableCount >= stableChecksRequired) {
        debug(`waitForBidirectionalSync: converged in ${Date.now() - startTime}ms`);
        return; // Converged!
      }
    } else {
      if (stableCount > 0) {
        debug(`waitForBidirectionalSync: heads changed, resetting stable count`);
      }
      stableCount = 0;
      lastSeenHeads = currentHeads;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Timeout - but don't throw, just log a warning
  // The sync may still work, we just couldn't confirm stability
  debug(`waitForBidirectionalSync: timed out after ${timeoutMs}ms`);
  out.taskLine(`Sync stability check timed out after ${timeoutMs}ms`, true);
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

    // Process all entries in the directory
    for (const entry of doc.docs) {
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
    }
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

  try {
    await Promise.all(promises);
    debug(`waitForSync: all ${handlesToWaitOn.length} documents synced in ${Date.now() - startTime}ms (${alreadySynced} were already synced)`);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    debug(`waitForSync: failed after ${elapsed}ms: ${error}`);
    throw error;
  }
}
