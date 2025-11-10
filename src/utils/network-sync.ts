import { DocHandle, StorageId } from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";
import { span, attr } from "../tracing";

/**
 * Wait for documents to sync to the remote server
 */
export async function waitForSync(
  handlesToWaitOn: DocHandle<unknown>[],
  syncServerStorageId?: StorageId,
  timeoutMs: number = 60000
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

  let alreadySynced = 0;

  const promises = handlesToWaitOn.map((handle, index) =>
    span(
      `doc_${index + 1}_${handle.url.slice(-8)}`,
      (async () => {
        const docStartTime = Date.now();

        // Check if already synced
        const heads = handle.heads();
        const syncInfo = handle.getSyncInfo(syncServerStorageId);
        const remoteHeads = syncInfo?.lastHeads;
        const wasAlreadySynced = A.equals(heads, remoteHeads);

        attr("was_already_synced", wasAlreadySynced);

        if (wasAlreadySynced) {
          attr("elapsed_ms", 0);
          attr("poll_count", 0);
          alreadySynced++;
          return;
        }

        return span(
          "wait_for_convergence",
          (async () =>
            new Promise<void>((resolve, reject) => {
              let pollInterval: NodeJS.Timeout;
              let pollCount = 0;

              const cleanup = () => {
                clearTimeout(timeout);
                clearInterval(pollInterval);
                handle.off("remote-heads", onRemoteHeads);
              };

              const onConverged = () => {
                attr("elapsed_ms", Date.now() - docStartTime);
                attr("poll_count", pollCount);
                if (verbose) {
                  console.log(`✅ Document ${index + 1} synced: ${handle.url}`);
                }
                cleanup();
                resolve();
              };

              const timeout = setTimeout(() => {
                cleanup();
                attr("timeout", true);
                attr("poll_count", pollCount);

                reject(
                  new Error(
                    `Sync timeout after ${timeoutMs}ms for document ${handle.url}`
                  )
                );
              }, timeoutMs);

              // Simple sync checker without extra spans
              const isConverged = () => {
                const localHeads = handle.heads();
                const info = handle.getSyncInfo(syncServerStorageId);
                return A.equals(localHeads, info?.lastHeads);
              };

              // Event handler for faster detection
              const onRemoteHeads = ({
                storageId,
              }: {
                storageId: StorageId;
                heads: any;
              }) => {
                if (verbose) {
                  console.log(
                    `📡 Received remote heads event for ${handle.url}`
                  );
                }
                if (storageId === syncServerStorageId && isConverged()) {
                  onConverged();
                }
              };

              // Polling fallback
              const poll = () => {
                if (verbose) {
                  console.log(`🔍 Poll ${pollCount} for ${handle.url}`);
                }
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
                pollCount++;
                poll();
              }, 100);

              handle.on("remote-heads", onRemoteHeads);
            }))()
        );
      })(),
      { url: handle.url, index }
    )
  );

  try {
    await span(
      "await_all_documents",
      (async () => {
        await Promise.all(promises);
        const elapsed = Date.now() - startTime;
        attr("total_elapsed_ms", elapsed);
        attr("already_synced_count", alreadySynced);
        if (verbose) {
          console.log(`✅ All documents synced to network (took ${elapsed}ms)`);
        }
      })()
    );
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
