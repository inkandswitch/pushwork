import { type Repo, type RepoConfig, type NetworkAdapterInterface } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import * as fs from "fs/promises";
import * as path from "path";
import { DirectoryConfig, SyncProtocol } from "../types";

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
 * The Repo constructor calls set_subduction_logger() and new MemorySigner()
 * from @automerge/automerge-subduction/slim, which require the Wasm module
 * to be initialized first. automerge-repo exports initSubduction() to
 * handle this — it dynamically imports the non-/slim entry (which
 * auto-initializes the Wasm as a side effect).
 *
 * Both the Repo and initSubduction must be loaded via ESM dynamic import()
 * so they share the same module graph as the Repo's internal /slim imports.
 */
let cachedRepoClass: typeof Repo | undefined;

async function getRepoClass(): Promise<typeof Repo> {
  if (cachedRepoClass) return cachedRepoClass;

  // Import Repo and initialize Subduction Wasm via automerge-repo's
  // initSubduction() helper. This must happen before new Repo() because
  // the constructor calls set_subduction_logger() and new MemorySigner()
  // which require the Wasm module to be ready.
  //
  // Both imports use the ESM dynamic import wrapper so they share the
  // same module graph as the Repo's internal /slim imports.
  const repoMod = await dynamicImport("@automerge/automerge-repo");
  await repoMod.initSubduction();
  cachedRepoClass = repoMod.Repo as typeof Repo;
  return cachedRepoClass;
}

/**
 * Scan a directory tree for 0-byte files, which indicate incomplete writes
 * from a previous run (process exited before storage flushed). Returns true
 * if any are found.
 */
async function hasCorruptStorage(dir: string): Promise<boolean> {
  try {
    await fs.access(dir);
  } catch {
    return false;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await hasCorruptStorage(fullPath)) return true;
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      if (stat.size === 0) return true;
    }
  }
  return false;
}

/**
 * Create an Automerge repository with configuration-based setup.
 *
 * `protocol` selects the sync backend:
 *   - "subduction" (default) — uses the Subduction sync backend built
 *     into automerge-repo. The Repo manages its own SubductionSource
 *     internally; we just pass `subductionWebsocketEndpoints` and the
 *     Repo handles connection management, sync, and retries.
 *   - "legacy" — uses the traditional WebSocket network adapter for
 *     sync via the classic automerge sync server.
 */
export async function createRepo(
  workingDir: string,
  config: DirectoryConfig,
  protocol: SyncProtocol = "subduction"
): Promise<Repo> {
  const RepoClass = await getRepoClass();

  const syncToolDir = path.join(workingDir, ".pushwork");
  const automergeDir = path.join(syncToolDir, "automerge");

  // Detect and recover from corrupt local storage (0-byte files left by
  // incomplete writes from a previous run). Wipe the cache so the Repo
  // hydrates cleanly from the sync server.
  if (await hasCorruptStorage(automergeDir)) {
    console.warn("[pushwork] Corrupt local storage detected, clearing cache...");
    await fs.rm(automergeDir, { recursive: true, force: true });
    await fs.mkdir(automergeDir, { recursive: true });
  }

  const storage = new NodeFSStorageAdapter(automergeDir);

  if (protocol === "subduction") {
    const endpoints: string[] = [];
    if (config.sync_enabled && config.sync_server) {
      endpoints.push(config.sync_server);
    }

    return new RepoClass({
      storage,
      subductionWebsocketEndpoints: endpoints,
    });
  }

  // Legacy: classic WebSocket sync adapter.
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
