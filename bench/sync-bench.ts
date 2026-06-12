/**
 * Offline CPU bench for `pushwork sync`.
 *
 * Generates a synthetic tree and runs the sync engine against a fully
 * offline Repo (`sync_enabled:false` ⇒ no Subduction endpoints, see
 * repo-factory.ts), so the measured cost is *pure local work*: change
 * detection, Automerge document creation, text diff/splice, and snapshot
 * (de)serialization. Network time is deliberately excluded — the
 * timeout/reentrancy behaviour is a separate, server-backed repro.
 *
 * Run with tsx (no build step needed):
 *
 *   npx tsx bench/sync-bench.ts --files 2000 --size 512 --text 1 --fanout 20
 *   npx tsx bench/sync-bench.ts --files 5000 --size 256 --text 0   # binary
 *
 * Flags:
 *   --files  N   number of files to generate            (default 1000)
 *   --size   N   bytes per file                          (default 512)
 *   --text   R   fraction [0..1] of files that are text  (default 1)
 *   --fanout N   files per leaf directory                (default 20)
 *   --keep       don't delete the temp dir afterwards
 *
 * The profile (phases, event-loop drift, peak RSS) goes to stderr; a
 * one-line JSON summary goes to stdout.
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";

import { SyncEngine } from "../src/core/sync-engine";
import { ConfigManager } from "../src/core/config";
import { createRepo } from "../src/utils/repo-factory";
import { getPlainUrl } from "../src/utils";
import {
  getProfileReport,
  printProfileReport,
  resetProfile,
  setProfilingEnabled,
  startDriftProbe,
  stopDriftProbe,
} from "../src/utils/profile";
import { DirectoryDocument } from "../src/types";
import { AutomergeUrl } from "@automerge/automerge-repo";

interface Args {
  files: number;
  size: number;
  text: number;
  fanout: number;
  keep: boolean;
  online: boolean;
  clone: string;
  cloneLocal: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string, def: string): string => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : def;
  };
  return {
    files: parseInt(get("--files", "1000"), 10),
    size: parseInt(get("--size", "512"), 10),
    text: parseFloat(get("--text", "1")),
    fanout: parseInt(get("--fanout", "20"), 10),
    keep: a.includes("--keep"),
    // --online ⇒ sync against the real Subduction server (prod). Default
    // is fully offline (sync_enabled:false) for deterministic CPU bench.
    online: a.includes("--online"),
    // --clone <url> ⇒ pull the given root URL into a fresh dir (online),
    // measuring the pull path instead of generating + uploading a tree.
    clone: get("--clone", ""),
    // --clone-local ⇒ fully offline clone: generate + ingest a tree in a
    // source dir (untimed), copy its automerge storage into a fresh dir,
    // then measure the pull-everything sync from local storage. Isolates
    // the clone path's CPU (doc materialization) deterministically.
    cloneLocal: a.includes("--clone-local"),
  };
}

function makeTextContent(seedIdx: number, size: number): string {
  const line =
    `line ${seedIdx} ` + "lorem ipsum dolor sit amet ".repeat(4) + "\n";
  let s = "";
  while (s.length < size) s += line;
  return s.slice(0, size);
}

function makeBinaryContent(seedIdx: number, size: number): Buffer {
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) b[i] = (seedIdx * 31 + i * 7) & 0xff;
  if (size > 0) b[0] = 0; // NUL ⇒ classified binary
  return b;
}

async function generateTree(root: string, args: Args): Promise<void> {
  for (let f = 0; f < args.files; f++) {
    const d = Math.floor(f / args.fanout);
    const dir = path.join(root, `d${Math.floor(d / 50)}`, `d${d}`);
    await fs.mkdir(dir, { recursive: true });
    const isText = (f % 100) / 100 < args.text;
    if (isText) {
      await fs.writeFile(
        path.join(dir, `f${f}.txt`),
        makeTextContent(f, args.size)
      );
    } else {
      await fs.writeFile(
        path.join(dir, `f${f}.bin`),
        makeBinaryContent(f, args.size)
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-bench-"));
  try {
    await fs.mkdir(path.join(root, ".pushwork", "automerge"), {
      recursive: true,
    });

    const cloneMode = args.clone.length > 0;

    // Generate a tree only when uploading; clone pulls an existing root.
    let genMs = 0;
    if (!cloneMode && !args.cloneLocal) {
      const genStart = performance.now();
      await generateTree(root, args);
      genMs = Math.round(performance.now() - genStart);
    }

    // Offline (default): sync disabled ⇒ createRepo passes no endpoints.
    // Online (--online) and clone: sync against the default Subduction
    // prod server.
    const config = new ConfigManager(root).getDefaultDirectoryConfig();
    config.sync_enabled = cloneMode || args.online;

    // --clone-local setup (untimed): ingest the tree in a SOURCE dir with
    // its own engine, then copy its automerge storage into `root` so the
    // measured sync pulls everything from local storage.
    let localCloneSourceUrl: string | undefined;
    if (args.cloneLocal) {
      const srcRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "pushwork-bench-src-")
      );
      try {
        await fs.mkdir(path.join(srcRoot, ".pushwork", "automerge"), {
          recursive: true,
        });
        await generateTree(srcRoot, args);
        const srcConfig = new ConfigManager(
          srcRoot
        ).getDefaultDirectoryConfig();
        srcConfig.sync_enabled = false;
        const srcRepo = await createRepo(srcRoot, srcConfig, "subduction");
        const srcEngine = new SyncEngine(srcRepo, srcRoot, srcConfig);
        const dirName = path.basename(srcRoot);
        const srcRootHandle = srcRepo.create({
          "@patchwork": { type: "folder" },
          name: dirName,
          title: dirName,
          docs: [],
        } as DirectoryDocument);
        localCloneSourceUrl = getPlainUrl(srcRootHandle.url);
        await srcEngine.setRootDirectoryUrl(localCloneSourceUrl as AutomergeUrl);
        // Source ingest must NOT use worker modes — keep the measured side
        // the only variable.
        const savedMode = process.env.PUSHWORK_PARALLEL_INGEST;
        delete process.env.PUSHWORK_PARALLEL_INGEST;
        const srcResult = await srcEngine.sync({ protocol: "subduction" });
        if (savedMode !== undefined)
          process.env.PUSHWORK_PARALLEL_INGEST = savedMode;
        if (!srcResult.success) throw new Error("clone-local source ingest failed");
        await srcRepo.shutdown();
        await fs.cp(
          path.join(srcRoot, ".pushwork", "automerge"),
          path.join(root, ".pushwork", "automerge"),
          { recursive: true }
        );
      } finally {
        await fs.rm(srcRoot, { recursive: true, force: true });
      }
    }

    const repo = await createRepo(root, config, "subduction");
    const engine = new SyncEngine(repo, root, config);

    let rootUrl: string;
    if (cloneMode) {
      // Pull an existing remote tree into this fresh dir.
      rootUrl = getPlainUrl(args.clone as AutomergeUrl);
      await engine.setRootDirectoryUrl(rootUrl as AutomergeUrl);
    } else if (args.cloneLocal) {
      rootUrl = localCloneSourceUrl!;
      await engine.setRootDirectoryUrl(rootUrl as AutomergeUrl);
    } else {
      // Mirror `init`'s root directory document.
      const dirName = path.basename(root);
      const rootDoc: DirectoryDocument = {
        "@patchwork": { type: "folder" },
        name: dirName,
        title: dirName,
        docs: [],
      };
      const rootHandle = repo.create(rootDoc);
      rootUrl = getPlainUrl(rootHandle.url);
      await engine.setRootDirectoryUrl(rootUrl as AutomergeUrl);
    }
    // Print the root URL up front so it's grabbable even if interrupted.
    process.stderr.write(`ROOT_URL ${rootUrl}\n`);

    setProfilingEnabled(true);
    resetProfile();
    startDriftProbe();
    const syncStart = performance.now();
    const result = await engine.sync({ protocol: "subduction" });
    const syncMs = Math.round(performance.now() - syncStart);

    // Flushing storage on shutdown is real work; without yielding it's
    // where the deferred Subduction saves land. Measure it so total wall
    // is comparable across yield budgets.
    const shutdownStart = performance.now();
    await repo.shutdown();
    const shutdownMs = Math.round(performance.now() - shutdownStart);
    stopDriftProbe();
    printProfileReport(
      cloneMode
        ? `CLONE(prod) pulled=${result.filesChanged}`
        : args.cloneLocal
          ? `CLONE(local) pulled=${result.filesChanged} files=${args.files} size=${args.size}B`
          : `${args.online ? "ONLINE(prod)" : "offline"} files=${args.files} ` +
              `size=${args.size}B text=${args.text}`
    );

    const summary = {
      config: args,
      mode: cloneMode
        ? "clone"
        : args.cloneLocal
          ? "clone-local"
          : args.online
            ? "online"
            : "offline",
      rootUrl,
      genMs,
      syncMs,
      shutdownMs,
      totalMs: syncMs + shutdownMs,
      filesChanged: result.filesChanged,
      success: result.success,
      errors: result.errors.length,
      warnings: result.warnings.length,
      sampleErrors: result.errors.slice(0, 3).map((e) => String(e.error)),
      sampleWarnings: result.warnings.slice(0, 3),
      ...getProfileReport(),
    };
    process.stdout.write(JSON.stringify(summary) + "\n");
  } finally {
    if (!args.keep) await fs.rm(root, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
