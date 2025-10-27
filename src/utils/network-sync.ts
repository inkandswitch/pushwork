import { DocHandle, StorageId } from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";

/**
 * Wait for documents to sync to the remote server
 * Based on patchwork-cli implementation with timeout for debugging
 */
export async function waitForSync(
  handlesToWaitOn: DocHandle<unknown>[],
  syncServerStorageId?: StorageId,
  timeoutMs: number = 60000 // 60 second timeout for debugging
): Promise<void> {
  const startTime = Date.now();

  if (!syncServerStorageId) {
    console.warn(
      "No sync server storage ID provided. Skipping network sync wait."
    );
    return;
  }

  if (handlesToWaitOn.length === 0) {
    console.log("🔄 No documents to sync");
    return;
  }

  // Debug logging only in verbose mode (can be controlled via env var later)
  const verbose = false;

  if (verbose) {
    console.log(
      `🔄 Waiting for ${handlesToWaitOn.length} documents to sync...`
    );
    console.log(`📡 Using sync server storage ID: ${syncServerStorageId}`);

    handlesToWaitOn.forEach((handle, i) => {
      const localHeads = handle.heads();
      const syncInfo = handle.getSyncInfo(syncServerStorageId);
      const remoteHeads = syncInfo?.lastHeads;
      console.log(`  📄 Document ${i + 1}: ${handle.url}`);
      console.log(`    🏠 Local heads: ${JSON.stringify(localHeads)}`);
      console.log(`    🌐 Remote heads: ${JSON.stringify(remoteHeads)}`);
      console.log(
        `    ✅ Already synced: ${A.equals(localHeads, remoteHeads)}`
      );
    });
  }

  const promises = handlesToWaitOn.map(
    (handle, index) =>
      new Promise<void>((resolve, reject) => {
        let pollInterval: NodeJS.Timeout;

        const timeout = setTimeout(() => {
          clearInterval(pollInterval);
          const localHeads = handle.heads();
          const syncInfo = handle.getSyncInfo(syncServerStorageId);
          const remoteHeads = syncInfo?.lastHeads;
          console.log(`⏰ TIMEOUT for document ${index + 1}: ${handle.url}`);
          console.log(`  Final local heads: ${JSON.stringify(localHeads)}`);
          console.log(`  Final remote heads: ${JSON.stringify(remoteHeads)}`);
          reject(
            new Error(
              `Sync timeout after ${timeoutMs}ms for document ${handle.url}`
            )
          );
        }, timeoutMs);

        const checkSync = () => {
          const newHeads = handle.heads();
          const syncInfo = handle.getSyncInfo(syncServerStorageId);
          const remoteHeads = syncInfo?.lastHeads;

          if (verbose) {
            console.log(`🔍 Checking sync for ${handle.url}:`);
            console.log(`  Local heads: ${JSON.stringify(newHeads)}`);
            console.log(`  Remote heads: ${JSON.stringify(remoteHeads)}`);
            console.log(`  Heads equal: ${A.equals(newHeads, remoteHeads)}`);
          }

          // If the remote heads are already up to date, we can resolve immediately
          if (A.equals(newHeads, remoteHeads)) {
            if (verbose) {
              console.log(`✅ Document ${index + 1} synced: ${handle.url}`);
            }
            clearTimeout(timeout);
            clearInterval(pollInterval);
            resolve();
            return true;
          }
          return false;
        };

        // Check if already synced
        if (checkSync()) {
          return;
        }

        // Periodically re-check if heads have converged (polling fallback)
        pollInterval = setInterval(() => {
          if (checkSync()) {
            clearInterval(pollInterval);
          }
        }, 100); // Check every 100ms for faster response

        // Also wait for remote-heads event (faster when events work)
        const onRemoteHeads = ({
          storageId,
          heads,
        }: {
          storageId: StorageId;
          heads: any;
        }) => {
          if (verbose) {
            console.log(`📡 Received remote heads event for ${handle.url}:`);
            console.log(`  Event storage ID: ${storageId}`);
            console.log(`  Expected storage ID: ${syncServerStorageId}`);
            console.log(`  Event heads: ${JSON.stringify(heads)}`);
            console.log(
              `  Current local heads: ${JSON.stringify(handle.heads())}`
            );
          }

          if (
            storageId === syncServerStorageId &&
            A.equals(handle.heads(), heads)
          ) {
            if (verbose) {
              console.log(
                `✅ Document ${index + 1} synced via event: ${handle.url}`
              );
            }
            clearTimeout(timeout);
            clearInterval(pollInterval);
            handle.off("remote-heads", onRemoteHeads);
            resolve();
          } else if (verbose) {
            console.log(`❌ Heads/storage mismatch for ${handle.url}`);
          }
        };

        if (verbose) {
          console.log(`👂 Listening for remote-heads events on ${handle.url}`);
        }
        handle.on("remote-heads", onRemoteHeads);
      })
  );

  try {
    await Promise.all(promises);
    const elapsed = Date.now() - startTime;
    if (verbose) {
      console.log(`✅ All documents synced to network (took ${elapsed}ms)`);
    }
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`❌ Sync wait failed after ${elapsed}ms: ${error}`);
    throw error;
  }
}

/**
 * Get the storage ID for the sync server
 * Using the same ID as patchwork-cli for consistency
 */
export function getSyncServerStorageId(customStorageId?: string): StorageId {
  return (customStorageId ||
    "3760df37-a4c6-4f66-9ecd-732039a9385d") as StorageId;
}
