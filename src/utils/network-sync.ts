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

  console.log(`🔄 Waiting for ${handlesToWaitOn.length} documents to sync...`);
  console.log(`📡 Using sync server storage ID: ${syncServerStorageId}`);

  // Debug: Log document URLs and initial heads
  handlesToWaitOn.forEach((handle, i) => {
    const localHeads = handle.heads();
    const syncInfo = handle.getSyncInfo(syncServerStorageId);
    const remoteHeads = syncInfo?.lastHeads;
    console.log(`  📄 Document ${i + 1}: ${handle.url}`);
    console.log(`    🏠 Local heads: ${JSON.stringify(localHeads)}`);
    console.log(`    🌐 Remote heads: ${JSON.stringify(remoteHeads)}`);
    console.log(`    ✅ Already synced: ${A.equals(localHeads, remoteHeads)}`);
  });

  const promises = handlesToWaitOn.map(
    (handle, index) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
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

          console.log(`🔍 Checking sync for ${handle.url}:`);
          console.log(`  Local heads: ${JSON.stringify(newHeads)}`);
          console.log(`  Remote heads: ${JSON.stringify(remoteHeads)}`);
          console.log(`  Heads equal: ${A.equals(newHeads, remoteHeads)}`);

          // If the remote heads are already up to date, we can resolve immediately
          if (A.equals(newHeads, remoteHeads)) {
            console.log(`✅ Document ${index + 1} synced: ${handle.url}`);
            clearTimeout(timeout);
            resolve();
            return true;
          }
          return false;
        };

        // Check if already synced
        if (checkSync()) {
          return;
        }

        // Otherwise, wait for remote-heads event
        const onRemoteHeads = ({
          storageId,
          heads,
        }: {
          storageId: StorageId;
          heads: any;
        }) => {
          console.log(`📡 Received remote heads event for ${handle.url}:`);
          console.log(`  Event storage ID: ${storageId}`);
          console.log(`  Expected storage ID: ${syncServerStorageId}`);
          console.log(`  Event heads: ${JSON.stringify(heads)}`);
          console.log(
            `  Current local heads: ${JSON.stringify(handle.heads())}`
          );

          if (
            storageId === syncServerStorageId &&
            A.equals(handle.heads(), heads)
          ) {
            console.log(
              `✅ Document ${index + 1} synced via event: ${handle.url}`
            );
            clearTimeout(timeout);
            handle.off("remote-heads", onRemoteHeads);
            resolve();
          } else {
            console.log(`❌ Heads/storage mismatch for ${handle.url}`);
          }
        };

        console.log(`👂 Listening for remote-heads events on ${handle.url}`);
        handle.on("remote-heads", onRemoteHeads);
      })
  );

  try {
    await Promise.all(promises);
    console.log("✅ All documents synced to network");
  } catch (error) {
    console.error(`❌ Sync wait failed: ${error}`);
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
