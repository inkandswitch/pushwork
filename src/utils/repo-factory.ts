import { Repo } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import * as crypto from "crypto";
import * as path from "path";
import { createRequire } from "module";
import { DirectoryConfig } from "../types";

// Resolve subduction from automerge-repo's perspective to ensure same module instance
const automergeRepoPath = require.resolve("@automerge/automerge-repo");
const requireFromAutomergeRepo = createRequire(automergeRepoPath);

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
 * Create an Automerge repository with Subduction backend.
 * The local automerge-repo branch requires Subduction.
 */
export async function createRepo(
  workingDir: string,
  config: DirectoryConfig,
): Promise<Repo> {
  const syncToolDir = path.join(workingDir, ".pushwork");
  const storageAdapter = new NodeFSStorageAdapter(
    path.join(syncToolDir, "automerge"),
  );

  const { SubductionStorageBridge } =
    await import("@automerge/automerge-repo-subduction-bridge");
  // Import from automerge-repo's perspective to ensure same module instance
  const { Subduction, SubductionWebSocket } =
    requireFromAutomergeRepo("@automerge/automerge_subduction");

  const signer = new NodeSigner();
  const storage = new SubductionStorageBridge(storageAdapter);
  const subduction = await Subduction.hydrate(signer, storage);

  if (config.sync_enabled) {
    try {
      const conn = await SubductionWebSocket.tryDiscover(
        new URL("wss://pdx.subduction.keyhive.org"),
        signer
      );
      await subduction.attach(conn);
    } catch (e) {
      console.warn("No Subduction server, running local-only:", e);
    }
  }

  return new Repo({
    network: [],
    subduction,
  } as ConstructorParameters<typeof Repo>[0]);
}
