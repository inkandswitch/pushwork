import { type Repo, type RepoConfig, type NetworkAdapterInterface } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import * as path from "path";
import { DirectoryConfig } from "../types";

/**
 * Perform a real ESM dynamic import that tsc won't rewrite to require().
 *
 * TypeScript with `"module": "commonjs"` compiles `await import("x")` to
 * `require("x")`, which resolves CJS entries instead of ESM entries. The
 * Wasm module instance is different between the CJS and ESM module graphs,
 * so initializing via CJS require() doesn't help the ESM /slim imports
 * inside automerge-repo.
 *
 * This helper uses `new Function` to create a real `import()` expression
 * that Node.js evaluates as ESM, sharing the same module graph as the
 * Repo's internal imports.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<any>;

/**
 * Initialize the Subduction Wasm module and return the Repo constructor.
 *
 * As of automerge-repo 2.6.0-subduction.9, the Repo constructor always
 * creates a SubductionSource internally (even without endpoints), which
 * imports from @automerge/automerge-subduction/slim. The /slim entry does
 * NOT auto-init the Wasm — we must do it before any Repo construction.
 *
 * Both the subduction init and the Repo must be loaded via ESM dynamic
 * import() so they share the same module graph.
 */
let cachedRepoClass: typeof Repo | undefined;

async function getRepoClass(): Promise<typeof Repo> {
  if (cachedRepoClass) return cachedRepoClass;

  // Initialize Subduction Wasm — the ESM node entry calls initSync
  // on the same Wasm module that /slim re-exports from.
  await dynamicImport("@automerge/automerge-subduction");

  // Import Repo from the same ESM module graph so its internal /slim
  // import sees the initialized Wasm.
  const repoMod = await dynamicImport("@automerge/automerge-repo");
  cachedRepoClass = repoMod.Repo as typeof Repo;
  return cachedRepoClass;
}

/**
 * Create an Automerge repository with configuration-based setup.
 *
 * When `sub` is true, uses the Subduction sync backend built into
 * automerge-repo. The Repo manages its own SubductionSource internally —
 * we just pass `subductionWebsocketEndpoints` and the Repo handles
 * connection management, sync, and retries.
 *
 * When `sub` is false (default), uses the traditional WebSocket network
 * adapter for sync via the automerge sync server.
 */
export async function createRepo(
  workingDir: string,
  config: DirectoryConfig,
  sub: boolean = false
): Promise<Repo> {
  const RepoClass = await getRepoClass();

  const syncToolDir = path.join(workingDir, ".pushwork");
  const storage = new NodeFSStorageAdapter(path.join(syncToolDir, "automerge"));

  if (sub) {
    const endpoints: string[] = [];
    if (config.sync_enabled && config.sync_server) {
      endpoints.push(config.sync_server);
    }

    return new RepoClass({
      storage,
      subductionWebsocketEndpoints: endpoints,
      // CLI needs fast sync — default periodic interval is 30s which is
      // far too slow for a "sync and exit" workflow.
      periodicSyncInterval: 2000,
      // Disable the 5-minute batch sync timer — we control the lifecycle.
      batchSyncInterval: 0,
    });
  }

  // Default: WebSocket sync adapter
  const repoConfig: RepoConfig = { storage };

  if (config.sync_enabled && config.sync_server) {
    // Load the WebSocket adapter via ESM dynamic import to stay in the
    // same module graph as the Repo.
    const wsMod = await dynamicImport("@automerge/automerge-repo-network-websocket");
    // The websocket adapter package (subduction.8) hasn't updated its
    // NetworkAdapter base-class types to match the repo's new
    // NetworkAdapterInterface (which added state() and stricter
    // EventEmitter generics). At runtime the adapter has all required
    // methods; this is purely a declaration mismatch.
    const networkAdapter = new wsMod.BrowserWebSocketClientAdapter(
      config.sync_server
    ) as unknown as NetworkAdapterInterface;
    repoConfig.network = [networkAdapter];
  }

  return new RepoClass(repoConfig);
}
