import { DocHandle, StorageId } from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";
import { span, attr } from "../tracing";
import { out } from "../cli/output";

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
    // No sync server storage ID - skip network sync
    return;
  }

  if (handlesToWaitOn.length === 0) {
    // No documents to sync
    return;
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
                if (storageId === syncServerStorageId && isConverged()) {
                  onConverged();
                }
              };

              // Polling fallback
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
      })()
    );
  } catch (error) {
    const elapsed = Date.now() - startTime;
    out.errorBlock("FAILED", `after ${elapsed}ms`);
    out.crash(error);
    throw error;
  }
}
