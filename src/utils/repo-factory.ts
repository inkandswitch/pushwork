import "./node-polyfills.js";
import { Repo } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import * as subductionModule from "@automerge/automerge-subduction";
import {
  initSubductionModule,
  SubductionStorageBridge,
} from "@automerge/automerge-repo-subduction-bridge";
import * as path from "path";
import * as os from "os";
import { DirectoryConfig } from "../types/index.js";

const { WebCryptoSigner, Subduction } = subductionModule;

let subductionModuleInitialized = false;

function ensureSubductionModuleInit() {
  if (!subductionModuleInitialized) {
    initSubductionModule(subductionModule);
    subductionModuleInitialized = true;
  }
}

export interface RepoWithSubduction {
  repo: Repo;
  subduction: any;
}

/**
 * Create an Automerge repository with Subduction-based setup.
 * Returns both the repo and the raw subduction instance so callers
 * can use fullSync/syncAll for reliable sync confirmation.
 */
export async function createRepo(
  workingDir: string,
  config: DirectoryConfig
): Promise<RepoWithSubduction> {
  ensureSubductionModuleInit();

  const syncToolDir = path.join(workingDir, ".pushwork");
  const nodeStorage = new NodeFSStorageAdapter(path.join(syncToolDir, "automerge"));

  const signer = await WebCryptoSigner.setup();
  const storageBridge = new SubductionStorageBridge(nodeStorage);
  const subduction = await Subduction.hydrate(signer, storageBridge);

  // Connect to sync server if sync is enabled
  if (config.sync_enabled && config.sync_server) {
    await subduction.connectDiscover(
      new URL(config.sync_server),
      signer
    );
  }

  const repo = new Repo({ subduction } as any);
  return { repo, subduction };
}

/**
 * Create an ephemeral Automerge repository for remote reads.
 * Uses a temporary directory for storage.
 */
export async function createEphemeralRepo(
  syncServer: string
): Promise<Repo> {
  ensureSubductionModuleInit();

  const tmpDir = path.join(os.tmpdir(), `pushwork-ephemeral-${Date.now()}`);
  const nodeStorage = new NodeFSStorageAdapter(tmpDir);

  const signer = await WebCryptoSigner.setup();
  const storageBridge = new SubductionStorageBridge(nodeStorage);
  const subduction = await Subduction.hydrate(signer, storageBridge);

  await subduction.connectDiscover(
    new URL(syncServer),
    signer
  );

  return new Repo({ subduction } as any);
}
