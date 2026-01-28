import { Repo, StorageId } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import * as crypto from "crypto";
import * as path from "path";
import { DirectoryConfig } from "../types";

/**
 * Ed25519 signer for Node.js using the crypto module.
 * @see https://github.com/automerge/automerge-repo/blob/main/examples/sync-server/index.js#L17
 */
class NodeSigner {
  #privateKey: crypto.KeyObject;
  #publicKey: crypto.KeyObject;

  constructor() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
  }

  sign(message: Uint8Array): Uint8Array {
    const signature = crypto.sign(null, Buffer.from(message), this.#privateKey);
    return new Uint8Array(signature);
  }

  verifyingKey(): Uint8Array {
    const exported = this.#publicKey.export({ type: "spki", format: "der" });
    return new Uint8Array(exported.slice(-32));
  }
}

/**
 * Create an Automerge repository with configuration-based setup.
 * When use_subduction is true, uses Subduction (same backend as tiny-patchwork).
 */
export async function createRepo(
  workingDir: string,
  config: DirectoryConfig,
): Promise<Repo> {
  const syncToolDir = path.join(workingDir, ".pushwork");
  const storageAdapter = new NodeFSStorageAdapter(
    path.join(syncToolDir, "automerge"),
  );

  if (config.use_subduction && config.sync_enabled) {
    const { SubductionStorageBridge } =
      await import("@automerge/automerge-repo-subduction-bridge");
    const { Subduction, SubductionWebSocket } =
      await import("@automerge/automerge_subduction");

    const signer = new NodeSigner();
    const storage = new SubductionStorageBridge(storageAdapter);
    const subduction = await Subduction.hydrate(signer, storage);

    //const syncServer = config.sync_server || DEFAULT_SUBDUCTION_SYNC_SERVER;
    try {
      const conn = await SubductionWebSocket.tryDiscover(
        new URL("wss://pdx.subduction.keyhive.org"),
        signer,
        "pdx.subduction.keyhive.org", // Service name (server's default is its socket address)
        5000,
      );
      await subduction.attach(conn);
    } catch (e) {
      console.warn("No Subduction server, running local-only:", e);
    }

    // Repo accepts subduction when using automerge-repo with subduction support
    return new Repo({
      network: [],
      subduction,
    } as ConstructorParameters<typeof Repo>[0]);
  }

  const repoConfig: any = { storage: storageAdapter };

  // Add network adapter only if sync is enabled and server is configured
  if (config.sync_enabled && config.sync_server) {
    const networkAdapter = new BrowserWebSocketClientAdapter(
      config.sync_server,
    );
    repoConfig.network = [networkAdapter];
    repoConfig.enableRemoteHeadsGossiping = true;
  }

  const repo = new Repo(repoConfig);

  // Subscribe to the sync server storage for network sync
  if (
    config.sync_enabled &&
    config.sync_server &&
    config.sync_server_storage_id
  ) {
    repo.subscribeToRemotes([config.sync_server_storage_id as StorageId]);
  }

  return repo;
}
