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
import { toSedimentreeId as toSedimentreeIdFromRepoFactory } from "./repo-factory";

/** @internal Mock SedimentreeId conversion in unit tests. */
let sedimentreeIdForTests:
  | ((handle: DocHandle<unknown>) => Promise<unknown>)
  | undefined;

export function __setSedimentreeIdForTests(
  fn: ((handle: DocHandle<unknown>) => Promise<unknown>) | undefined,
): void {
  sedimentreeIdForTests = fn;
}

async function toSedimentreeId(handle: DocHandle<unknown>): Promise<unknown> {
  if (sedimentreeIdForTests) return sedimentreeIdForTests(handle);
  return toSedimentreeIdFromRepoFactory(handle);
}

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
 * @param options - Configuration options
 */
export async function waitForBidirectionalSync(
  repo: Repo,
  rootDirectoryUrl: AutomergeUrl | undefined,
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

  if (!rootDirectoryUrl) {
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

    // After first scan: scale timeout to tree size and reset the clock.
    // The first scan is just establishing a baseline — its duration
    // shouldn't count against the stability-wait timeout.
    if (pollCount === 1) {
      const scanDuration = Date.now() - startTime;
      dynamicTimeoutMs = Math.max(timeoutMs, 5000 + currentHeads.size * 50) + scanDuration;
      debug(`waitForBidirectionalSync: first scan took ${scanDuration}ms, timeout now ${dynamicTimeoutMs}ms for ${currentHeads.size} docs`);
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
            changedDocs.push(url);
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
 * Result of waitForSync — lists which handles failed to sync.
 */
export interface SyncWaitResult {
  failed: DocHandle<unknown>[];
}

/** Maximum documents to sync concurrently to avoid flooding the server */
const SYNC_BATCH_SIZE = 10;

/**
 * Wait for a single document handle to sync to the server.
 * Resolves with the handle on success, rejects with the handle on timeout.
 */
function waitForHandleSync(
  handle: DocHandle<unknown>,
  syncServerStorageId: StorageId,
  timeoutMs: number,
  startTime: number,
): Promise<DocHandle<unknown>> {
  return new Promise<DocHandle<unknown>>((resolve, reject) => {
    let pollInterval: NodeJS.Timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(pollInterval);
      handle.off("remote-heads", onRemoteHeads);
    };

    const onConverged = () => {
      debug(`waitForSync: ${handle.url}... converged in ${Date.now() - startTime}ms`);
      cleanup();
      resolve(handle);
    };

    const timeout = setTimeout(() => {
      debug(`waitForSync: ${handle.url}... timed out after ${timeoutMs}ms`);
      cleanup();
      reject(handle);
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

    // Initial check
    if (isConverged()) {
      cleanup();
      resolve(handle);
      return;
    }

    // Start polling and event listening
    pollInterval = setInterval(() => {
      if (isConverged()) {
        onConverged();
      }
    }, 100);

    handle.on("remote-heads", onRemoteHeads);
  });
}

/**
 * Wait for documents to sync to the remote server.
 * Processes handles in batches to avoid flooding the server.
 * Returns a result with any failed handles instead of throwing,
 * so callers can attempt recovery (e.g. recreating documents).
 */
export async function waitForSync(
  handlesToWaitOn: DocHandle<unknown>[],
  syncServerStorageId?: StorageId,
  timeoutMs: number = 60000,
  repo?: Repo,
): Promise<SyncWaitResult> {
  const startTime = Date.now();

  if (handlesToWaitOn.length === 0) {
    debug("waitForSync: no documents to sync");
    return { failed: [] };
  }

  // Subduction mode: run an explicit sync round per document and require
  // at least one connected peer to succeed (same criterion as SubductionSource).
  if (!syncServerStorageId) {
    if (!repo) {
      throw new Error(
        "waitForSync: Subduction verification requires a Repo instance (pass repo as the 4th argument)",
      );
    }
    debug(
      `waitForSync: Subduction syncWithAllPeers for ${handlesToWaitOn.length} documents`,
    );
    out.taskLine(`Uploading ${handlesToWaitOn.length} documents via Subduction`);
    return waitForSyncViaSubduction(repo, handlesToWaitOn, timeoutMs, startTime);
  }

  debug(`waitForSync: waiting for ${handlesToWaitOn.length} documents (timeout=${timeoutMs}ms, batchSize=${SYNC_BATCH_SIZE})`);

  // Separate already-synced from needs-sync
  const needsSync: DocHandle<unknown>[] = [];
  let alreadySynced = 0;

  for (const handle of handlesToWaitOn) {
    const heads = handle.heads();
    const syncInfo = handle.getSyncInfo(syncServerStorageId);
    const remoteHeads = syncInfo?.lastHeads;
    if (A.equals(heads, remoteHeads)) {
      alreadySynced++;
      debug(`waitForSync: ${handle.url}... already synced`);
    } else {
      debug(`waitForSync: ${handle.url}... needs sync (remoteHeads=${remoteHeads ? 'present' : 'missing'})`);
      needsSync.push(handle);
    }
  }

  if (needsSync.length > 0) {
    debug(`waitForSync: ${alreadySynced} already synced, ${needsSync.length} need sync`);
    out.taskLine(`Uploading: ${alreadySynced}/${handlesToWaitOn.length} already synced, waiting for ${needsSync.length} more`);
  } else {
    debug(`waitForSync: all ${handlesToWaitOn.length} already synced`);
    return { failed: [] };
  }

  // Process in batches to avoid flooding the server
  const failed: DocHandle<unknown>[] = [];
  let synced = alreadySynced;

  for (let i = 0; i < needsSync.length; i += SYNC_BATCH_SIZE) {
    const batch = needsSync.slice(i, i + SYNC_BATCH_SIZE);
    const batchNum = Math.floor(i / SYNC_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(needsSync.length / SYNC_BATCH_SIZE);

    if (totalBatches > 1) {
      debug(`waitForSync: batch ${batchNum}/${totalBatches} (${batch.length} docs)`);
      out.update(`Uploading batch ${batchNum}/${totalBatches} (${synced}/${handlesToWaitOn.length} done)`);
    }

    const results = await Promise.allSettled(
      batch.map(handle => waitForHandleSync(handle, syncServerStorageId, timeoutMs, startTime))
    );

    for (const result of results) {
      if (result.status === "rejected") {
        failed.push(result.reason as DocHandle<unknown>);
      } else {
        synced++;
      }
    }
  }

  const elapsed = Date.now() - startTime;
  if (failed.length > 0) {
    debug(`waitForSync: ${failed.length} documents failed after ${elapsed}ms`);
    out.taskLine(`Upload: ${synced} synced, ${failed.length} failed after ${(elapsed / 1000).toFixed(1)}s`, true);
  } else {
    debug(`waitForSync: all ${handlesToWaitOn.length} documents synced in ${elapsed}ms (${alreadySynced} were already synced)`);
    out.taskLine(`All ${handlesToWaitOn.length} documents uploaded to server (${(elapsed / 1000).toFixed(1)}s)`);
  }

  return { failed };
}

type PeerBatchSyncResult = {
  success: boolean;
  stats?: unknown;
  transport_errors?: unknown[];
};

type SubductionSync = {
  syncWithAllPeers: (
    id: unknown,
    subscribe: boolean,
    timeoutMs?: number | bigint,
  ) => Promise<{ entries: () => PeerBatchSyncResult[] }>;
};

function subductionSyncTimeoutMs(ms: number): number | bigint {
  // automerge-subduction 0.13+ expects a BigInt timeout in milliseconds.
  return BigInt(Math.max(1, Math.floor(ms)));
}

/**
 * Wait for upload by running syncWithAllPeers on each document.
 * Succeeds when at least one connected peer reports success for that round.
 */
async function waitForSyncViaSubduction(
  repo: Repo,
  handles: DocHandle<unknown>[],
  timeoutMs: number,
  startTime: number,
): Promise<SyncWaitResult> {
  // Subduction websocket may still be connecting when push finishes a batch.
  if (repo.networkSubsystem) {
    await repo.networkSubsystem.whenReady();
  }

  const subduction = (await repo.subduction) as SubductionSync;
  const documentIds = handles.map(h => h.documentId);
  await repo.flush(documentIds);

  const failed: DocHandle<unknown>[] = [];
  let synced = 0;

  for (let i = 0; i < handles.length; i += SYNC_BATCH_SIZE) {
    const batch = handles.slice(i, i + SYNC_BATCH_SIZE);
    const batchNum = Math.floor(i / SYNC_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(handles.length / SYNC_BATCH_SIZE);

    if (totalBatches > 1) {
      debug(`waitForSync(sub): batch ${batchNum}/${totalBatches} (${batch.length} docs)`);
      out.update(
        `Uploading batch ${batchNum}/${totalBatches} (${synced}/${handles.length} done)`,
      );
    }

    const results = await Promise.allSettled(
      batch.map(handle => syncHandleWithAllPeers(subduction, handle, timeoutMs, startTime)),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        failed.push(result.reason as DocHandle<unknown>);
      } else {
        synced++;
      }
    }
  }

  const elapsed = Date.now() - startTime;
  if (failed.length > 0) {
    debug(`waitForSync(sub): ${failed.length} documents failed after ${elapsed}ms`);
    out.taskLine(
      `Upload: ${synced} synced, ${failed.length} failed after ${(elapsed / 1000).toFixed(1)}s`,
      true,
    );
  } else {
    debug(`waitForSync(sub): all ${handles.length} documents synced in ${elapsed}ms`);
    out.taskLine(
      `All ${handles.length} documents uploaded to server (${(elapsed / 1000).toFixed(1)}s)`,
    );
  }

  return { failed };
}

async function syncHandleWithAllPeers(
  subduction: SubductionSync,
  handle: DocHandle<unknown>,
  timeoutMs: number,
  startTime: number,
): Promise<DocHandle<unknown>> {
  const sid = await toSedimentreeId(handle);
  const deadline = startTime + timeoutMs;
  const pollMs = 250;
  let lastPeerCount = 0;
  let lastAnySuccess = false;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      const peerResultMap = await subduction.syncWithAllPeers(
        sid,
        true,
        subductionSyncTimeoutMs(Math.min(remaining, 30_000)),
      );
      const results = peerResultMap.entries();
      lastPeerCount = results.length;
      lastAnySuccess = results.some(r => r.success);

      if (lastPeerCount > 0 && lastAnySuccess) {
        debug(
          `waitForSync(sub): ${handle.url}... synced in ${Date.now() - startTime}ms (${lastPeerCount} peer(s))`,
        );
        return handle;
      }

      debug(
        `waitForSync(sub): ${handle.url}... retry (peers=${lastPeerCount}, success=${lastAnySuccess})`,
      );
    } catch (e) {
      debug(`waitForSync(sub): ${handle.url}... sync round error: ${e}`);
    }

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  debug(
    `waitForSync(sub): ${handle.url}... failed after ${Date.now() - startTime}ms (peers=${lastPeerCount}, success=${lastAnySuccess})`,
  );
  throw handle;
}
