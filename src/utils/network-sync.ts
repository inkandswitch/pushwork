import { DocHandle, StorageId } from "@automerge/automerge-repo";
import * as A from "@automerge/automerge";
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

  const promises = handlesToWaitOn.map((handle) => {
    // Check if already synced
    const heads = handle.heads();
    const syncInfo = handle.getSyncInfo(syncServerStorageId);
    const remoteHeads = syncInfo?.lastHeads;
    const wasAlreadySynced = A.equals(heads, remoteHeads);

    if (wasAlreadySynced) {
      alreadySynced++;
      return Promise.resolve();
    }

    // Wait for convergence
    return new Promise<void>((resolve, reject) => {
      let pollInterval: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(pollInterval);
        handle.off("remote-heads", onRemoteHeads);
      };

      const onConverged = () => {
        cleanup();
        resolve();
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Sync timeout after ${timeoutMs}ms for document ${handle.url}`
          )
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
  } catch (error) {
    const elapsed = Date.now() - startTime;
    out.errorBlock("FAILED", `after ${elapsed}ms`);
    out.crash(error);
    throw error;
  }
}
