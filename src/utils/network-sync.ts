import { DocHandle, StorageId } from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";
import { span, spanSync, attr } from "../tracing";

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

        const initialHeads = await span(
          "check_initial_sync",
          (async () => {
            const heads = handle.heads();
            const syncInfo = handle.getSyncInfo(syncServerStorageId);
            const remoteHeads = syncInfo?.lastHeads;
            return {
              heads,
              remoteHeads,
              wasAlreadySynced: A.equals(heads, remoteHeads),
            };
          })()
        );

        const wasAlreadySynced = initialHeads.wasAlreadySynced;
        attr("was_already_synced", wasAlreadySynced);

        if (wasAlreadySynced) {
          attr("elapsed_ms", Date.now() - docStartTime);
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

              const timeout = setTimeout(() => {
                clearInterval(pollInterval);
                const localHeads = handle.heads();
                const syncInfo = handle.getSyncInfo(syncServerStorageId);
                const remoteHeads = syncInfo?.lastHeads;

                attr("timeout", true);
                attr("poll_count", pollCount);

                console.log(
                  `⏰ TIMEOUT for document ${index + 1}: ${handle.url}`
                );
                console.log(
                  `  Final local heads: ${JSON.stringify(localHeads)}`
                );
                console.log(
                  `  Final remote heads: ${JSON.stringify(remoteHeads)}`
                );
                reject(
                  new Error(
                    `Sync timeout after ${timeoutMs}ms for document ${handle.url}`
                  )
                );
              }, timeoutMs);

              const checkSync = async (pollNum: number) => {
                return span(
                  `poll_${pollNum}`,
                  (async () => {
                    const newHeads = spanSync("get_local_heads", () =>
                      handle.heads()
                    );
                    const syncInfo = spanSync("get_sync_info", () =>
                      handle.getSyncInfo(syncServerStorageId)
                    );
                    const remoteHeads = syncInfo?.lastHeads;

                    if (verbose) {
                      console.log(`🔍 Checking sync for ${handle.url}:`);
                      console.log(`  Local heads: ${JSON.stringify(newHeads)}`);
                      console.log(
                        `  Remote heads: ${JSON.stringify(remoteHeads)}`
                      );
                      console.log(
                        `  Heads equal: ${A.equals(newHeads, remoteHeads)}`
                      );
                    }

                    const isConverged = spanSync("compare_heads", () =>
                      A.equals(newHeads, remoteHeads)
                    );
                    attr("converged", isConverged);

                    if (isConverged) {
                      attr("elapsed_ms", Date.now() - docStartTime);
                      attr("poll_count", pollCount);

                      if (verbose) {
                        console.log(
                          `✅ Document ${index + 1} synced: ${handle.url}`
                        );
                      }
                      clearTimeout(timeout);
                      clearInterval(pollInterval);
                      resolve();
                      return true;
                    }
                    return false;
                  })()
                );
              };

              // Check if already synced
              span(
                "initial_poll",
                (async () => {
                  if (await checkSync(0)) {
                    return;
                  }

                  // Periodically re-check if heads have converged (polling fallback)
                  pollInterval = setInterval(async () => {
                    pollCount++;
                    if (await checkSync(pollCount)) {
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
                    span(
                      "remote_heads_event",
                      (async () => {
                        if (verbose) {
                          console.log(
                            `📡 Received remote heads event for ${handle.url}:`
                          );
                          console.log(`  Event storage ID: ${storageId}`);
                          console.log(
                            `  Expected storage ID: ${syncServerStorageId}`
                          );
                          console.log(
                            `  Event heads: ${JSON.stringify(heads)}`
                          );
                          console.log(
                            `  Current local heads: ${JSON.stringify(
                              handle.heads()
                            )}`
                          );
                        }

                        const storageMatches =
                          storageId === syncServerStorageId;
                        const headsMatch = A.equals(handle.heads(), heads);
                        attr("storage_matches", storageMatches);
                        attr("heads_match", headsMatch);

                        if (storageMatches && headsMatch) {
                          if (verbose) {
                            console.log(
                              `✅ Document ${index + 1} synced via event: ${
                                handle.url
                              }`
                            );
                          }
                          clearTimeout(timeout);
                          clearInterval(pollInterval);
                          handle.off("remote-heads", onRemoteHeads);
                          resolve();
                        } else if (verbose) {
                          console.log(
                            `❌ Heads/storage mismatch for ${handle.url}`
                          );
                        }
                      })()
                    );
                  };

                  if (verbose) {
                    console.log(
                      `👂 Listening for remote-heads events on ${handle.url}`
                    );
                  }
                  handle.on("remote-heads", onRemoteHeads);
                })()
              );
            }))()
        );
      })(),
      { url: handle.url, index }
    )
  );

  try {
    await Promise.all(promises);
    if (verbose) {
      const elapsed = Date.now() - startTime;
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
