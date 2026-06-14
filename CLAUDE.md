# Pushwork - Claude's Notes

Always update this file as you learn new things about the codebase — patterns, pitfalls, performance considerations, architectural decisions. This is your persistent memory across sessions.

## What to do after changing code

Always run `npm run build` (which runs `tsc`) after finishing changes to verify compilation.

## Code style

- `src/core/sync-engine.ts` and `src/commands.ts` use tabs for indentation
- `src/utils/network-sync.ts` and `src/cli.ts` use 2-space indentation
- Adding a new CLI command requires changes in 4 places: types (`src/types/config.ts` for options interface), engine (`src/core/sync-engine.ts` for method), commands (`src/commands.ts` for command function), CLI (`src/cli.ts` for registration + import)

## What pushwork is

Pushwork is a CLI tool for bidirectional file synchronization using Automerge CRDTs. It maps a local filesystem directory to a tree of Automerge documents, syncing changes in both directions through a relay server. Multiple users can edit the same files and changes merge automatically without conflicts.

## Architecture overview

```
CLI (cli.ts) -> Commands (commands.ts) -> SyncEngine (core/sync-engine.ts)
                                              |
                                    +---------+---------+
                                    |         |         |
                              ChangeDetector  |    MoveDetector
                                         SnapshotManager
```

### Key files

- `src/cli.ts` - Commander.js CLI entry point, defines all commands
- `src/commands.ts` - Command implementations, `setupCommandContext()` is the shared setup
- `src/core/sync-engine.ts` - The heart of the system. Two-phase sync: push local changes, then pull remote changes
- `src/core/change-detection.ts` - Compares local filesystem state against snapshot to find changes
- `src/core/move-detection.ts` - Detects file renames/moves by content similarity
- `src/core/snapshot.ts` - Manages `.pushwork/snapshot.json`, tracks what's been synced
- `src/core/config.ts` - Config loading/merging (defaults < global < local)
- `src/utils/text-diff.ts` - `spliceText()` for character-level CRDT edits, `updateTextContent()` for handling legacy immutable strings, `readDocContent()` for normalizing content reads

### Type definitions

- `src/types/documents.ts` - FileDocument, DirectoryDocument, DirectoryEntry
- `src/types/config.ts` - DirectoryConfig, GlobalConfig, all CLI option interfaces
- `src/types/snapshot.ts` - SyncSnapshot, SnapshotFileEntry, SyncResult

## How sync works

### Data model

Every file becomes an Automerge document (`FileDocument`) with content stored as either collaborative text (for text files, supporting character-level merge) or raw bytes (for binary files). Directories become `DirectoryDocument`s containing a `docs` array of `{name, type, url}` entries pointing to children. The whole thing forms a tree rooted at one directory document.

### Two-phase sync

1. **Push** (local -> remote): Detect local filesystem changes vs snapshot. New files get new Automerge docs. Modified files get spliced. Deleted files are removed from their parent directory document (the orphaned doc is left as-is).
2. **Network sync**: Wait for documents to reach the relay server, level-by-level deepest-first (children before parents).
3. **Pull** (remote -> local): Re-detect changes after network sync. Write remote-only changes to the local filesystem.

### Remote change detection (the single walk)

Incremental remote detection (`ChangeDetector.detectRemoteTreeWalk`, for a populated snapshot) is **one tree walk** (`walkRemoteDir`) that visits each directory once: it merges what used to be two separate scans — `detectRemoteChanges` (a per-file `findFileInDirectoryHierarchy` that re-`repo.find`-ed every shared ancestor directory, O(files × depth) on the one socket) and `detectNewRemoteDocuments`. Per directory it reports deletions (snapshot child names no longer listed remotely — `reportRemoteDeletion`), classifies tracked files (`classifyTrackedRemoteFile`: head/URL-replacement check, artifacts fetch fresh content), and new files (`classifyNewRemoteFile`: defers URL-only changes when shard-pull can take them). The empty-snapshot/clone path still uses `detectNewRemoteDocuments` (streaming/deferred). New *clean* remote files defer so `pullRemoteChanges` auto-shards a big incremental pull past `AUTO_SHARD_THRESHOLD`.

> [!WARNING]
> **Do NOT add subtree pruning on snapshot directory heads** (the obvious "skip unchanged subtrees / O(1) idle watch" optimization). It was built and reverted (ADR-025) — unsound for three independent reasons proven against the live server: (1) `repo.find(doc)` is what *triggers* Subduction to sync it, so a pruned (never-found) subtree is read **stale** and its remote changes are missed; (2) the end-of-sync head-update loop AND `pushLocalChanges` advance `snapshot.directories[dir].head` to the current/merged head even when those remote changes were never reconciled to disk, so a head match doesn't prove reconciliation — pruning then skips the dir **forever** (deletions never propagate); (3) a pre-detect full-stabilize delivers remote artifact changes that `detectLocalChanges` misclassifies as local edits, churning a push that **resurrects** deleted artifacts. Sound pruning needs a per-dir *reconciled* head (set during pull, not re-fetched) + a real delivery barrier — both noted follow-ups.

### Snapshot

The snapshot (`.pushwork/snapshot.json`) records:

- `rootDirectoryUrl` - the root Automerge document URL
- `files` - map of relative path -> `{url, head}` for every tracked file
- `directories` - map of relative path -> `{url, head}` for every tracked directory

The `head` (Automerge document heads) is how change detection works: if a document's current heads differ from the snapshot heads, it has changed.

### Versioned URLs

Automerge URLs can include heads (e.g. `automerge:docid#head1,head2`). Pushwork stores versioned URLs in directory entries so clients can fetch the exact version. `getPlainUrl()` strips heads when you need a mutable handle; `getVersionedUrl()` adds current heads.

## Immutable string handling

Old Automerge documents may store text content as `RawString` (aka `ImmutableString`) instead of the collaborative text CRDT. You can't `splice` into these. Two strategies:

1. **`updateTextContent()`** - Inside a change callback, detects if the field is a regular string (splice-able) or legacy immutable (assign directly to convert it).
2. **`updateRemoteFile()` nuclear path** - If `A.isImmutableString(content)` is true, throws away the old document entirely, creates a brand new one with proper mutable text, and replaces the entry in the parent directory via `replaceFileInDirectory()`.

`readDocContent()` normalizes `RawString` to plain strings when reading.

## CLI commands

Global output flags (any command): `--porcelain` (machine-readable: `<level>\t<message>` lines, no spinners/colors/prompts — scripts should prefer this over scraping interactive output), `-q/--quiet` (only final summaries + errors), `--silent` (errors-to-stderr only; check exit codes). Default is an interactive @clack/prompts UI (intro/outro frame, spinners, confirm prompts on e.g. clone-overwrite). Prompts auto-accept their default when any of those flags are set or stdin/stdout isn't a TTY, so CI/scripts never hang. `out.log()` is the bare data path (`url`, `ls`, `diff --name-only` filenames) — never decorated in any mode. Counted loops render @clack progress bars (`out.progress(msg, total)` → porcelain `progress\t<msg>\t<total>`); the engine owns per-phase indicators (sync/init/clone commands only frame the run with intro/outro and summary blocks). One live region: any leveled `out.*` call dismisses an active spinner/bar, so in-loop reporting must go through `debug()` or `bar.advance()`. See `src/utils/output.ts` (design ported from darn's cliclack `Output` controller).

**Noninteractive / scripting.** Three layers keep init/sync/clone/watch unattended: (1) the flags above; (2) **non-TTY auto-degradation** — when `process.stdout.isTTY` is false (piped/redirected) and no flag is set, the `plain` path in `output.ts` renders spinners/bars as plain start/`done (time)` lines instead of clack's cursor-animated regions (clack itself only degrades under `CI=true`, so without this a piped run spews `[1G[J` escape codes); (3) **no blocking prompts** — the only prompt is the clone-overwrite `out.confirm(…, false)`, which returns its `false` default when non-interactive → clean `exit(1)` with "Use `--force` to overwrite" (`--force` skips it). `init` aborts with `exit(1)` if already initialized; `watch` is signal-driven (SIGINT/SIGTERM). **Worker-phase progress bars** (`out.progress`): shard ingest (`runShardIngest` `onProgress`, per-shard), shard pull (`runShardPull` `onProgress`, per-file), and the streaming clone (spinner during the dir-walk since the total isn't known yet, then a bar for the download tail — the downloads overlap the walk, so the bar is created with the final count and caught up).

- `pushwork init [path]` - Initialize, creates root directory document
- `pushwork clone <url> <path>` - Clone from an Automerge URL
- `pushwork sync [path]` - Full bidirectional sync (default: force mode — uses default config, preserves snapshot for incremental change detection)
  - `--dry-run` - Preview only
  - `--gentle` - Use merged config instead of defaults
  - `--nuclear` - Recreate all Automerge documents from scratch (except root)
  - `--force` - Silently accepted for backwards compatibility (does nothing, force is now the default)
- `pushwork track <url> [path]` - Set root directory URL without full init (creates minimal `.pushwork/snapshot.json`). `root` is a hidden alias.
- `pushwork commit [path]` - Save to Automerge docs without network sync
- `pushwork status [path]` - Show sync status
- `pushwork diff [path]` - Show changes
- `pushwork url [path]` - Print root Automerge URL
- `pushwork ls [path]` - List tracked files
- `pushwork config [path]` - View config
- `pushwork watch [path]` - Watch + build + sync loop
- `pushwork rm [path]` - Remove local `.pushwork` data

## Config

Stored in `.pushwork/config.json` (local) and `~/.pushwork/config.json` (global). Merged: defaults < global < local.

Key fields:

- `sync_enabled: boolean` - Whether to do network sync
- `sync_server: string` - WebSocket relay URL (default: `wss://sync3.automerge.org`)
- `sync_server_storage_id: StorageId` - Server identity for sync verification
- `exclude_patterns: string[]` - Gitignore-style patterns. Defaults live in `DEFAULT_EXCLUDE_PATTERNS` (`src/types/config.ts`) and cover VCS metadata plus the large machine-generated dirs of common ecosystems (`node_modules`, `.pnpm-store`, `.yarn/cache`, `target`, `__pycache__`, `.venv`, `dist-newstyle`, `_build`, `result`, `.gradle`, `.terraform`, …). Both `getDefaultGlobalConfig` and `getDefaultDirectoryConfigForProtocol` spread this one constant (and `DEFAULT_ARTIFACT_DIRECTORIES`). NOTE: `sync` runs force-defaults, so it **resets `exclude_patterns` to these defaults** every run — a user's custom excludes only apply under `sync --gentle`. So expanding the defaults is what actually makes a new exclusion take effect for plain `sync`.
- `sync.move_detection_threshold: number` - Similarity threshold for move detection (0-1, default 0.7)

## Network sync details

- Uses `waitForSync()` to verify documents reach the server by comparing local and remote heads
  - Takes an optional `noun` (`{one, many}`, default `document(s)`) for its progress text. In shard-ingest mode the **files** are uploaded by the worker repos (their own sockets), so the main thread only `waitForSync`s the **directory** documents — the engine passes `{directory, directories}` when every tracked handle is a directory, so the bar reads "Synced N directories to server" instead of a misleadingly small "N documents".
- Uses `waitForBidirectionalSync()` to poll until document heads stabilize (no more incoming changes)
  - Accepts optional `handles` param to check only specific handles instead of full tree traversal
  - **The initial pre-detect wait is `handles: [rootHandle]` (root-only), NOT a full-tree scan.** A full scan there `repo.find`s every doc — on a clone that *downloads the entire tree* under a "Connecting" spinner, and the dynamic timeout (`max(5000, 5000 + docCount*50)`, ~45 s for 1000 docs) means it waits out most of that budget while heads churn. That download is redundant with change detection's own per-doc fetches. Root-only stabilizes just the directory listing before the walk; the tree download then happens once, concurrently, in detection. Measured: clone "Connected" phase 49 s → 0.8 s.
  - Timeout scales dynamically: `max(timeoutMs, 5000 + docCount * 50)` so large trees don't prematurely time out
  - Tree traversal (`collectHeadsRecursive`) fetches siblings concurrently via `Promise.all`
- Documents sync level-by-level, deepest first, so children are on the server before their parents
- `handlesByPath` map tracks which documents changed and need syncing
- **Remote discovery is concurrent.** `ChangeDetector.discoverRemoteDocumentsRecursive` (the clone/pull download) processes directory entries via `mapWithConcurrency(IO_CONCURRENCY)` and recurses concurrently — serial `for…await` made a 1000-file clone 1000 sequential fetches. It fetches each file's content+heads in ONE `repo.find` (`getCurrentRemoteContentAndHead`), threads a single time-budgeted `makeYielder()` through the walk (so clack's spinner repaints and the Subduction socket gets serviced during the download), and reports a live discovered-count via `onRemoteProgress` → the engine's throttled `makeRemoteProgressReporter` ("Detecting changes (N remote documents)").
- **The clone/pull bottleneck is the single WSS, not CPU or client concurrency.** `createRepo` opens ONE Subduction websocket (`subductionWebsocketEndpoints: [syncServer]`); every `repo.find` multiplexes over it. Profiled (`PUSHWORK_PROFILE=1` on `clone`, split into `discover:find` vs `discover:materialize`): materialization is ~free even at 256 KB (Automerge load is cheap); the wall is dominated by per-doc fetches whose effective throughput collapses with doc size — 512 B → ~5 s/800 docs, 32 KB → ~9 s/200 docs, **256 KB → ~114 s/200 docs (~450 KB/s)**: head-of-line blocking on the one socket. `IO_CONCURRENCY` (`cores*4`, env `PUSHWORK_IO_CONCURRENCY`) only hides latency up to the socket's throughput — sweeping 12→384 is noise-dominated on a busy machine; very low (4) clearly under-parallelizes, very high doesn't help. The real throughput fix is **multiple sockets = shard mode** (`PUSHWORK_PARALLEL_INGEST=2`): each worker owns a separate Repo/SubductionSource/socket (distinct peer), measured 5–6× on large clones. Two cheaper multi-socket attempts were measured and REJECTED (don't retry): (1) passing the same endpoint N times — Subduction host-keys the peer, no distribution; (2) **N in-process Repos sharing the storage dir, round-robin the fetch** — 2–6× *slower*, because N SubductionSources contend on the single event loop (each runs its own sync scheduler / recompute / keepalive). Worker threads are load-bearing: each SubductionSource needs its own thread, not just its own socket. Large docs (256 KB) may additionally be bandwidth-bound to the one server, where even shard mode's gain shrinks.
- **Clone uses a streaming, work-stealing download pool** (`StreamingClonePool` in `ingest-pool.ts`; clone workers are message-fed, not given a static `tasks` array). Two wins over the old static round-robin partition: (1) **work-stealing** — the main thread keeps each worker at `PER_WORKER_CONCURRENCY=16` in flight (env `PUSHWORK_PER_WORKER_CONCURRENCY`) and idle workers pick up the next queued file, so a worker stuck on a 4 MB bundle doesn't starve the others (static partition had bad tail latency on size-skewed trees); (2) **pipelining** — for a fresh clone (empty snapshot + no local files + sync on + shard not disabled), `sync()` takes the `streamingClonePull` fast path: it walks the remote tree on the main thread and `pool.submit`s each file *as discovered* (`ChangeDetector.streamRemoteFiles` → `onFile`), so the dir-walk overlaps the download instead of walk-everything-then-download. The streaming clone skips the normal detect/push/pull entirely (nothing local to push). Each worker still fetches its in-flight slots concurrently over its own socket; serial `for…await` (the original bug) capped a clone at `workers`(8) round-trips total, losing to the main-thread 96-on-one-socket for many small docs. Measured (fair interleaved A/B, real 20 MB repo, 740 tiny + several 4 MB `dist/` bundles): static ~35 s → work-stealing batch ~34 s → **streaming pipeline ~28 s** (~18% over batch). Residual is server download throughput (the pull alone varies 20–92 s run-to-run). NOTE: the shard-INGEST worker's build loop stays serial — `repo.create`/`handle.change` is synchronous CPU work, parallelized by having N workers, with a single batched upload at the end.
- **Shard mode is now AUTO for big clones/pushes (no flag).** `shouldAutoShard(docCount)` enables the worker path when `docCount >= AUTO_SHARD_THRESHOLD` (64) — below that, worker startup (~1 s Wasm+Repo each) doesn't pay for itself and the main-thread path runs. `PUSHWORK_PARALLEL_INGEST=2`/`shard` forces it on at any size; `0`/`off` forces the single-socket path. Workers default-cap at `SHARD_WORKER_CAP=8`; `PUSHWORK_WORKERS` overrides it. The cap is right for *both* paths: ingest at cores−1=23 hit the EMFILE death spiral, and on the *download* path more workers are strictly *slower* — measured on the real 20 MB repo, clone w=8 ~37 s → w=16 ~48 s → w=24 ~66 s (no EMFILE on download). Workers spawn in parallel (`Promise.all(shards.map(… new Worker …))`, no await between), so it's NOT serialized startup — it's that each worker instantiates its own isolated Subduction Wasm and runs its own SubductionSource (scheduler/recompute/keepalive), so N of those *contend* for CPU/memory during init and add steady-state overhead, with no extra server throughput to offset it (the single server is throughput-bound). The clone win comes from per-worker fetch concurrency, NOT from more workers. The pull/clone download decision is two-stage: `shouldDeferRemoteContent(snapshot.files.size)` makes detection emit URL-only changes on a *fresh* snapshot (clone) so the count is known, then `pullRemoteFilesInShardedRepos` shards iff `deferred.length >= 64`, else main-thread fallback (`applyDeferredChangeOnMainThread`). Measured default-on: 256 KB×200 clone 101 s → **27 s** (3.7×); 20-file clone stays main-thread; both clone-verified byte-identical.

## Leaf-first ordering

`pushLocalChanges()` processes directories deepest-first via `batchUpdateDirectory()`, propagating subdirectory URL updates as it walks up toward the root. This ensures directory entries always point to the latest version of their children.

## The `changeWithOptionalHeads` helper

Used throughout sync-engine: if heads are available, calls `handle.changeAt(heads, cb)` to branch from a known version; otherwise falls back to `handle.change(cb)`. This is important for conflict-free merging when multiple peers are editing.

## Performance pitfalls

- **Avoid splicing large text deletions.** Automerge text CRDTs track every character as an individual op. `A.splice(doc, path, 0, largeString.length)` to clear a large file is O(n) in CRDT ops and very slow. This is why `deleteRemoteFile()` no longer clears content — it just lets the document become orphaned when removed from its parent directory.
- **Avoid diffing artifact files.** `diffChars()` is O(n\*m) and pointless for artifact directories since they use RawString (immutable snapshots). Artifact files should always be replaced with a fresh document rather than diffed+spliced. This applies to `updateRemoteFile()`, `applyMoveToRemote()`, and change detection. `ChangeDetector` skips `getContentAtHead()` and `getCurrentRemoteContent()` for artifact paths — it uses a SHA-256 `contentHash` stored in the snapshot to detect local changes, and checks heads to detect remote changes. If neither changed, the artifact is skipped entirely. The `contentHash` field on `SnapshotFileEntry` is optional and only populated for artifact files.
- **EVERY code path that writes an artifact snapshot entry MUST set `contentHash`.** A missing/stale hash makes the next sync see a phantom local edit, which replaces the artifact doc wholesale and churns directory entries; that churn CRDT-merges into duplicated/resurrected entries on other peers (the 2026-06-12 "deleted artifact files resurrect on clone" bug — clone's `applyRemoteChangeToLocal` was the path that missed it). The missing-hash fallback in `detectLocalChanges` now compares against remote content once and backfills rather than assuming changed, but don't rely on it: set the hash at the source. Guard test: "clone populates artifact contentHash; next sync must not replace docs" (`in-memory-sync.test.ts`).
- **Artifact directories are always nuked.** `batchUpdateDirectory` uses a plain `dirHandle.change()` (not `changeWithOptionalHeads`) for artifact directory paths and rebuilds the entire `docs` array from scratch. This avoids `changeAt` forking from stale heads, which previously caused bugs like deleted entries resurrecting. The rebuild reads the current entries, applies all changes (deletes, updates, additions, subdir URL updates), then splices out the old array and pushes the computed entries.
- **Sync timeout recovery.** `waitForSync()` returns `{ failed: DocHandle[] }` instead of throwing. When documents fail to sync (timeout or unavailable), `recreateFailedDocuments()` creates new Automerge docs with the same content, updates snapshot entries and parent directory references, then retries once. If documents still fail after recreation, it's reported as an error (not a warning) so the sync shows as "PARTIAL" rather than "SYNCED".
- **Document availability during clone.** `repo.find()` rejects with "Document X is unavailable" if the sync server doesn't have the document yet. `DocHandle.doc()` is synchronous and throws if the handle isn't ready. For clone scenarios, `sync()` retries `repo.find()` for the root document with exponential backoff (up to 6 attempts). `ChangeDetector.findDocument()` wraps `repo.find()` + `doc()` with retry logic for all document fetches during change detection.
- **Server load.** `enableRemoteHeadsGossiping` is disabled — pushwork syncs directly with the server so the gossip protocol is unnecessary overhead. `waitForSync` processes documents in batches of 10 (`SYNC_BATCH_SIZE`) to avoid flooding the server with concurrent sync messages. Without batching, syncing 100+ documents simultaneously can overwhelm the sync server (which is single-threaded with no backpressure).
- **`waitForBidirectionalSync` on large trees.** Full tree traversal (`getAllDocumentHeads`) is expensive because it `repo.find()`s every document. For post-push stabilization, pass the `handles` option to only check documents that actually changed. The initial pre-pull call still needs the full scan to discover remote changes. The dynamic timeout adds the first scan's duration on top of the base timeout, since the first scan is just establishing baseline — its duration shouldn't count against stability-wait time.
- **Versioned URLs and `repo.find()`.** `repo.find(versionedUrl)` returns a view handle whose `.heads()` returns the VERSION heads, not the current document heads. Always use `getPlainUrl()` when you need the current/mutable state. The snapshot head update loop at the end of `sync()` must use `getPlainUrl(snapshotEntry.url)` — without this, artifact directories (which store versioned URLs) get stale heads written to the snapshot, causing `changeAt()` to fork from the wrong point on the next sync. This was the root cause of the artifact deletion resurrection bug: `batchUpdateDirectory` would `changeAt` from an empty directory state where the file entry didn't exist yet, so the splice found nothing to delete.

## Event-loop starvation (Subduction timeouts on big trees)

The reported "high CPU + Subduction times out" symptom is **event-loop starvation**, not raw CPU. `pushLocalChanges` does thousands of small *synchronous* Automerge/Wasm calls (`repo.create`, `handle.change`/splice, `handle.heads()`, directory `changeWithOptionalHeads`). The `await`s between them resolve as **microtasks** (an `async` fn with no real await, or `repo.find` on a cached doc), and Node drains the entire microtask queue before reaching the macrotask phases — `timers` and, critically, `poll` (the WebSocket socket where Subduction reads sync messages and flushes keepalive pongs). So the loop monopolizes the thread for seconds, the server misses pongs, and the connection is reaped (`request timed out`). Measured: ingesting 2000 files blocked the loop for one ~6.5 s unbroken stretch (the 50 ms drift timer fired ~0× during it).

The fixes (all in `src/utils/concurrency.ts` + `sync-engine.ts`/`change-detection.ts`):

- **Macrotask yields.** `makeYielder(budgetMs)` returns a time-budgeted yield (`await new Promise(r => setImmediate(r))` once >`budgetMs` has elapsed). `pushLocalChanges` calls it in the moves loop, the per-file loop, and the directory loop (after `ensureDirectoryDocument`, so intermediate dirs with no direct file changes still yield). `setImmediate` fires in the `check` phase right after `poll`, so the socket gets serviced. **Time-budgeted, not count-based** — per-file Wasm cost varies 100×, so any fixed count is badly tuned for some workload. Default `YIELD_BUDGET_MS = 50` (env `PUSHWORK_YIELD_MS`, `0` disables — used by the repro test). Result: longest block 6.7 s → ~0.7 s, total wall **unchanged** (yielding moves Subduction's storage saves out of shutdown and into the sync window, it doesn't add work).
  - This app-level yield is the **single** mechanism covering all three push loops. An upstream `Repo.createAsync` variant (create + macrotask yield) was evaluated and **removed**: it only covered doc *creation*, while the dominant steady-state paths — `updateRemoteFile` (splice into an existing doc) and `applyMoveToRemote` — never call create, so `maybeYield` is required regardless. Keeping both was redundant (they overlapped only on the new-file path). `repo.create` is synchronous; callers that bulk-create just `await maybeYield()` in their own loop.
  - NOT redundant with the am-repo branch's own yields (`helpers/yield.ts`, used in `#saveNewCommits` prep / recompute / blob loads): those cover am-repo's *internal* loops; pushwork's cover pushwork's push loop, which upstream code cannot yield inside. Both layers are load-bearing (2026-06-12 audit).
- **Single FS scan.** `sync()` scans the local filesystem once (`changeDetector.getCurrentFilesystemState()`) and passes it to *both* `detectChanges` passes (new `precomputedFiles` arg). The local tree can't change mid-sync (pushwork is the only writer; pull runs after both passes). This killed the redundant `detect:post` rescan — which was ~10× the pre-push scan because by then `.pushwork/automerge` is full of this run's doc files and `listDirectory` globs the whole tree before excluding them. `detect:post` 2370 ms → ~550 ms.
- **Bounded I/O + hoisted matcher.** `mapWithConcurrency(items, IO_CONCURRENCY, fn)` (order-preserving pool, `IO_CONCURRENCY = cores*4`) replaces unbounded `Promise.all` for file reads (`getCurrentFilesystemState`) and stats (`fs.ts listDirectory`), so a 50k-file tree doesn't open 50k FDs / buffer 50k contents at once. `fs.ts` now compiles the `ignore` matcher **once** per `listDirectory` (was rebuilt per path) and filters before stat'ing.

> The residual ~0.7 s block is a *single* SubductionSource save (`#saveNewCommits`) blocking synchronously — a separate, Subduction-side follow-up, not pushwork's push loop. The detect doc-materialization fan-outs (`detectLocalChanges`/`detectRemoteChanges`) are still unbounded `Promise.all` (push to a shared array); bounding them is a noted follow-up for the 50k-file memory case.

### Profiling + bench (the measurement layer)

- **`--profile` flag / `PUSHWORK_PROFILE=1`** on `sync` prints to **stderr**: an event-loop **drift** summary (the key metric — longest single block = `maxDrift`; the timer should fire every 50 ms, drift = how late it was), per-phase timings, counters, and peak RSS, plus a machine-readable `PROFILE_JSON {...}` line. Implemented in `src/utils/profile.ts` (`startDriftProbe`/`profileAsync`/`profileSync`/`count`/`printProfileReport`); no-op unless enabled, so the hot-path wrappers cost one boolean check.
- **`bench/sync-bench.ts`** (run with `npx tsx`, no build): generates a synthetic tree and runs the engine against a **fully offline** Repo (`sync_enabled:false` ⇒ `createRepo` passes no Subduction endpoints, see `repo-factory.ts:150`), so it measures pure local CPU/FS work deterministically. Flags: `--files --size --text --fanout --keep`. Emits the profile to stderr + a JSON summary (incl. `syncMs`/`shutdownMs`/`totalMs`) to stdout.
- **`test/bench/sync-starvation.test.ts`** is a regression guard (gated behind `PUSHWORK_BENCH=1`; spawns the bench in a subprocess to dodge the Wasm/ESM-in-Jest wall). Asserts `maxDriftMs < 1500`: passes with the yield (~0.6 s), fails without it (~4 s). Run the negative with `PUSHWORK_YIELD_MS=0 PUSHWORK_BENCH=1`.
- Background: throughput floor (the ~3 ms/file create+splice+save, 822 MB RSS at 4k files) is *not* fixed by the yields — see the O(N²) storage scan below, which turned out to be most of it.

### The O(N²) storage-adapter scan (the real "high CPU" root cause)

The dominant per-doc CPU cost was **not** in pushwork or Automerge — it was `NodeFSStorageAdapter.cachedKeys` in `@automerge/automerge-repo-storage-nodefs`. `loadRange` called `Object.keys(this.cache).filter(k => k.startsWith(prefix))` — **O(total cached chunks)** — *synchronously* on every call. Every `repo.create`/`repo.find` registers the doc, and each source's `attach` calls `loadRange` (`SubductionSource` seeds `persistedHashes` via `listCommitIds`/`listFragmentIds`; `StorageSource` loads the doc). So registering N docs scanned the whole, ever-growing cache twice per doc ⇒ **O(N²) synchronous CPU**. This is what pegged the CPU and starved the Subduction keepalive on big push/clone trees.

Fix (upstream, in the am-repo monorepo): replace the flat-cache prefix scan with an incremental **segment-trie prefix index** (`KeyTrieNode` + `trieInsert`/`trieDelete`/`trieCollect`), maintained in lockstep with `cache` via `cacheSet`/`cacheDelete`/`cacheRollback`. `cachedKeys` is now **O(matches)**. A per-key `seq` preserves the insertion order the old `Object.keys` scan produced (the storage acceptance tests assert `loadRange` order). Segment-boundary matching mirrors the on-disk `walkdir`, and keys shard on fixed-length ids so no key is ever a segment-prefix of another — the result set is identical. All 21 adapter acceptance tests pass.

Measured (offline push 4000 files, `PUSHWORK_YIELD_MS=0`): `push:repo.create` 85.5 s → **10.2 s** (8.4×), `syncMs` 104 s → **21.3 s** (4.9×). Clone 2000 files: ~75–141 s → **38 s**.

> The clone-side `maxDrift` (5–10 s) is a **measurement artifact, not CPU starvation**: strace shows the main thread parked in `epoll_pwait` (idle CPU, no GC) *waiting for the socket*, while the drift probe's `unref()`'d 50 ms timer under-fires during genuine network-idle (its `samples` count is way below `wall/50`). The probe is accurate for CPU-bound work (offline push); treat its network-receive numbers with suspicion.

### Online shutdown stall — root-caused and FIXED (2026-06-12, am-repo `feed-macrotasks`)

Every online run used to stall ~25–30 s in `repo.shutdown()` at `SubductionSource.shutdown()` step 4 (`await saveSettled`). Root cause: `#saveNewCommits` called `subduction.addBatch` — the **store-and-broadcast** combinator (`store_built_batch` + `sync_with_all_peers`, a request/response roundtrip with every peer capped by the 30 s Wasm default deadline). Post-convergence broadcasts never got server responses, so every final save burned the full deadline (worker stalls clustered 29.9–30.1 s = pure deadline expiry). Pre-existing in published `subduction.29`; offline runs never stalled (no peers ⇒ broadcast no-op). The broadcast was also redundant: `#save`'s tail already arms an immediate `#doSync`, which runs its own `syncWithAllPeers` — every save broadcast **twice**.

The fix (on `feed-macrotasks`, committed in `6a83aad3a`, `src/subduction/source.ts`):

- **Store-only saves**: `#saveNewCommits` uses `storeBuiltBatch` (persist, no broadcast). `saveSettled` now gates on disk durability alone.
- **Shutdown quiesce pass**: the dropped broadcast was *accidentally load-bearing* — without it, a shard-mode init's directory docs never reached the server (clone returned 0 files). `shutdown()` now: awaits `saveSettled` (fast) → awaits per-entry `syncSettled` (in-flight `#doSync` rounds; new field mirroring `saveSettled`) → runs a final `#doSync` round for entries with un-broadcast commits (`needsResync || lastSyncResult === null`), through a 16-wide bounded pool with `SHUTDOWN_SYNC_TIMEOUT_MS = 5_000` (a short deadline so shutdown can't pin on a dead peer — data is durable locally and heals next session) → storage settle → disconnect. `#scheduleRecompute` is a no-op while `#shuttingDown`, so the quiesce pass is the only sync initiator during teardown.
- Validated: am-repo suite at baseline flake rate (51/51 subduction suites deterministic); online init 1000×512 B serial 40 s (was 64.5 s) and shard 30 s (was 130.9 s), **both clone-verified byte-identical from prod**; offline shutdown unchanged (~0.8 s).

### CRITICAL delivery semantics (Subduction mode)

`waitForSync` head-stability polling is **local-only** — it provides NO server-delivery guarantee (local heads are trivially stable when nothing is inbound). Actual delivery rests on (a) `#doSync` rounds during the run and (b) the shutdown quiesce pass above. Serial runs looked safe pre-fix only because their long `waitForSync` window gave `#doSync` time to finish; shard mode exposed the gap. Always **clone-verify** when testing delivery changes — a green "Synced N files" proves nothing about the server.

### Shard-pool worker termination + EMFILE (2026-06-12)

- **Shard-pool workers must be terminated eagerly.** A leftover Subduction sync timer (60 s) keeps worker threads alive after their `repo.shutdown()`; the pools resolve on `exit`, so `runShardIngest`/`runShardPull` call `worker.terminate()` as soon as the report message arrives (which is strictly after the worker's storage flush). Saved ~60 s per online shard run.
- **Online shard mode with cores−1 workers (23 here) hit an EMFILE death spiral** (196k errors from `saveSedimentreeId` atomicWrite/fsyncDir despite a 524k fd ulimit) during the post-upload save storm; 8 workers is fine. Root cause unfound (possibly the now-removed addBatch broadcast storm — not re-tested since the fix) — cap workers for online shard runs.
- Run-to-run online variance is ±20%; treat single runs gently.

### Integration-test debugging

`test/integration/in-memory-sync.test.ts` drives the compiled CLI as subprocesses — output is buffered and invisible while running ("No logs" is normal; tests take minutes). Set `PUSHWORK_TEST_VERBOSE=1` to tee each subprocess's stdout/stderr as `[cli] pushwork <args>` blocks. Use `--runInBand --verbose`; `pgrep -af dist/cli.js` shows the subprocesses churning.

## Sync backends (default: Subduction)

Pushwork supports two sync backends. Subduction is the default; legacy WebSocket is opt-in via `--legacy` on `init`/`clone`/`track`.

The Repo manages a `SubductionSource` internally — pushwork just passes `subductionWebsocketEndpoints` (Subduction mode) or constructs a `BrowserWebSocketClientAdapter` (legacy mode), and the Repo handles connection management, sync, and retries.

### How it works

- `repo-factory.ts`: Initializes Subduction Wasm via ESM dynamic import, then creates Repo. `createRepo(workingDir, config, protocol)` takes a `SyncProtocol`. When `protocol` is `"subduction"` (the default), passes `subductionWebsocketEndpoints: [syncServer]` and the Repo handles sync cadence internally. When `"legacy"`, constructs a `BrowserWebSocketClientAdapter` instead.
- Default Subduction server: `wss://subduction.sync.inkandswitch.com`; legacy server: `wss://sync3.automerge.org`
- `network-sync.ts`: When no `StorageId` is provided (Subduction mode), `waitForSync` falls back to head-stability polling (3 consecutive stable checks at 100ms intervals) instead of `getSyncInfo`-based verification
- `sync-engine.ts`: In Subduction mode, skips `recreateFailedDocuments` — SubductionSource has its own heal-sync retry logic
- Everything else (push/pull phases, artifact handling, `nukeAndRebuildDocs`, change detection) is identical across backends

### Wasm initialization

Since `automerge-repo@2.6.0-subduction.14` (pushwork currently pins `2.6.0-subduction.29`), the Repo constructor _always_ creates a `SubductionSource` internally (even without Subduction endpoints), which imports `MemorySigner` and `set_subduction_logger` from `@automerge/automerge-subduction/slim`. The `/slim` entry does NOT auto-init the Wasm — so Wasm must be initialized before _any_ `new Repo()` call, including the legacy WebSocket path.

`automerge-repo` exports `initSubduction()` which dynamically imports `@automerge/automerge-subduction` (the non-`/slim` entry that auto-inits Wasm). Pushwork calls this via `repoMod.initSubduction()` after loading the Repo module — no direct dependency on `@automerge/automerge-subduction` is needed.

`repo-factory.ts` uses a `new Function("specifier", "return import(specifier)")` wrapper to perform _real_ ESM `import()` calls that Node.js evaluates as ESM. This is necessary because TypeScript with `"module": "commonjs"` compiles `await import("x")` to `require("x")`, which resolves CJS entries. The CJS and ESM module graphs have separate Wasm instances, so initializing via CJS `require()` doesn't help the ESM `/slim` imports inside `automerge-repo`. The `new Function` trick bypasses tsc's transformation and shares the same ESM module graph as the Repo's internal imports.

The Repo class itself is also loaded via this ESM dynamic import (cached after first call) so that `new Repo()` sees the initialized Wasm module.

### Packaging notes

- **`@automerge/automerge-repo` and `@automerge/automerge-repo-storage-nodefs` are GIT DEPENDENCIES** (since 2026-06-12): `github:automerge/automerge-repo#feed-macrotasks&path:packages/<name>`. pnpm fetches the codeload tarball and runs each package's `prepare: tsc` on install (`dist/` is gitignored upstream). The old hand-copied-dist workflow (HANDOFF_2026-06-10.md) is OBSOLETE — `pnpm install` now produces the fixed packages instead of silently reverting them. Updating to a newer branch tip: `pnpm update @automerge/automerge-repo @automerge/automerge-repo-storage-nodefs` (re-resolves the branch head). The branch carries: nodefs trie fix, recompute coalescing, quadratic-flush fix, store-only saves + shutdown quiesce (ADR-023), and the packaging commit (prepare scripts, `catalog:`/`workspace:*` → concrete versions — pnpm cannot resolve those protocols from git monorepo subdirs, verified empirically).
- **pnpm settings live in `pnpm-workspace.yaml`, NOT the package.json `pnpm` field** — pnpm ≥10.3x silently ignores the latter (we discovered the ADR-021 override had been a no-op). The workspace file holds: the `@automerge/automerge` override (single Wasm copy), an `@automerge/automerge-repo` override redirecting storage-nodefs's inter-package dep to the same git ref, `onlyBuiltDependencies` (allows the git deps' `prepare` builds), and `blockExoticSubdeps: false` (the override makes a git URL appear as a subdependency, which newer pnpm blocks by default).
- `automerge-repo@2.6.0-subduction.29` (the version the branch builds as) pins `@automerge/automerge-subduction@0.15.0`. `automerge-repo-network-websocket` stays on published `.29` (unchanged upstream). See ADR-021/ADR-024.
- `RepoConfig` properly types the Subduction options pushwork uses (`subductionWebsocketEndpoints`, `signer`, `subductionPolicy`, `subductionAdapters`) — no `as any` cast needed.
- The `automerge-repo-network-websocket` adapter's `NetworkAdapter` types are slightly behind the repo's `NetworkAdapterInterface` (missing `state()` method in declarations). The adapter works at runtime; the type mismatch is worked around with `as unknown as NetworkAdapterInterface`.
- New `"heal-exhausted"` event on Repo fires when self-healing sync gives up after all retry attempts for a document. Not currently used by pushwork but available for better error reporting.

### Backend persistence in config

`--legacy` is only accepted on `init`, `clone`, and `track`. It persists `"protocol": "legacy"` in `.pushwork/config.json`. Default (Subduction) installs persist `"protocol": "subduction"`. All subsequent commands (`sync`, `watch`, etc.) read it from config via `resolveProtocol(localConfig)`. The force-defaults path in `setupCommandContext` preserves the protocol alongside `root_directory_url` and any user-configured `sync_server`.

When legacy mode is active, commands print a banner: "Using legacy WebSocket sync backend (from config)". No banner is printed for default Subduction operation.

The old opt-in `--sub` flag is **removed** (v1.4.0) — Subduction is now the default, so `--sub` errors with "unknown option". `--legacy` is the inverse selector.

`--sync-server` storage-id rule (D9): the storage ID is a legacy-only concept (`getSyncInfo` delivery verification). `validateSyncServer(opt, legacy)` in `cli.ts` enforces it — `--legacy` requires `<url> <storage-id>`; default (Subduction) mode accepts a URL only and **hard-errors** if a storage ID is supplied (rather than silently stripping it). Migration of old on-disk configs still strips stale storage-ids silently — the error is reserved for fresh CLI input.

Every `sync` run prints the root Automerge URL at the end.

### Config schema version and migration

The `config_version` field in `.pushwork/config.json` tracks schema version. Current: `CONFIG_VERSION = 1` (exported from `src/types/config.ts`).

- **v0** (no `config_version` field): pre-flip configs. Had a `subduction?: boolean` opt-in flag. Absence of that flag ⇒ classic WebSocket install.
- **v1**: Subduction is the default. Uses `"protocol": "subduction" | "legacy"` instead of `subduction: boolean`. Always written explicitly.

Migration is in `ConfigManager.migrateIfNeeded()`:

- `sync`, `watch`, and `commit` call `migrateConfigIfNeeded()` at the top, upgrading an existing v0 config in place. `init`/`clone`/`track` do _not_ call it — they write a fresh v1 config via `initializeWithOverrides` instead. Read-only commands (`status`, `diff`, `log`, `ls`, `url`) never touch disk — they read v0 configs transparently via `resolveProtocol` in memory.
- Migration reads the raw v0 config, infers protocol (`subduction: true` → `"subduction"`; `false` or absent → `"legacy"`), writes a backup to `config.json.bak` (or `.bak.1`, `.bak.2`, ... if prior backups exist), and rewrites the file in v1 shape. Prints a multi-line banner so the user sees what happened.
- `resolveProtocol(config)` is the single source of truth for backend selection across all paths. Given `null`/`undefined` it returns `"subduction"` (new-install default).

### Corrupt storage recovery

`repo-factory.ts` scans `.pushwork/automerge/` for 0-byte files before creating the Repo. These indicate incomplete writes from a previous run (process exited before storage flushed). If any are found, the entire automerge cache is wiped and recreated — data will re-download from the sync server. The snapshot (`.pushwork/snapshot.json`) is preserved so all document URLs are retained.

This is a safety net for the Subduction `HydrationError: LooseCommit too short` crash. The upstream fix (`Repo.shutdown()` now calls `flush()` and `SubductionSource.shutdown()` awaits pending writes) prevents the corruption from happening in the first place, but edge cases (SIGKILL, OOM, power loss) can still produce 0-byte files.
