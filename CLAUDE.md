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
- `exclude_patterns: string[]` - Gitignore-style patterns (default: `.git`, `node_modules`, `*.tmp`, `.pushwork`, `.DS_Store`)
- `sync.move_detection_threshold: number` - Similarity threshold for move detection (0-1, default 0.7)

## Network sync details

- Uses `waitForSync()` to verify documents reach the server by comparing local and remote heads
- Uses `waitForBidirectionalSync()` to poll until document heads stabilize (no more incoming changes)
  - Accepts optional `handles` param to check only specific handles instead of full tree traversal (used post-push in `sync()`)
  - Timeout scales dynamically: `max(timeoutMs, 5000 + docCount * 50)` so large trees don't prematurely time out
  - Tree traversal (`collectHeadsRecursive`) fetches siblings concurrently via `Promise.all`
- Documents sync level-by-level, deepest first, so children are on the server before their parents
- `handlesByPath` map tracks which documents changed and need syncing

## Leaf-first ordering

`pushLocalChanges()` processes directories deepest-first via `batchUpdateDirectory()`, propagating subdirectory URL updates as it walks up toward the root. This ensures directory entries always point to the latest version of their children.

**Invariant: any change to dist's heads must update parents recursively, leaf-first.** Local file changes are caught by the loop above. Heads can also drift from remote merges that land during `waitForBidirectionalSync` — the artifact directory advances locally but no file-level change is detected, so leaf-first propagation never kicks in and the parent's versioned URL goes stale. `findStaleArtifactDirs()` scans every artifact dir in the snapshot, compares its live `handle.heads()` against the heads encoded in its parent's stored URL entry, and returns paths that have drifted. `pushLocalChanges()` then folds these into `allDirsToProcess` and pre-populates `modifiedDirs` so the existing leaf-first machinery emits a `subdirUpdates` entry for each stale dir's parent. This is self-healing — even if drift happens after a sync exits, the next sync catches it.

## The `changeWithOptionalHeads` helper

Used throughout sync-engine: if heads are available, calls `handle.changeAt(heads, cb)` to branch from a known version; otherwise falls back to `handle.change(cb)`. This is important for conflict-free merging when multiple peers are editing.

## Performance pitfalls

- **Avoid splicing large text deletions.** Automerge text CRDTs track every character as an individual op. `A.splice(doc, path, 0, largeString.length)` to clear a large file is O(n) in CRDT ops and very slow. This is why `deleteRemoteFile()` no longer clears content — it just lets the document become orphaned when removed from its parent directory.
- **Avoid diffing artifact files.** `diffChars()` is O(n\*m) and pointless for artifact directories since they use RawString (immutable snapshots). Artifact files should always be replaced with a fresh document rather than diffed+spliced. This applies to `updateRemoteFile()`, `applyMoveToRemote()`, and change detection. `ChangeDetector` skips `getContentAtHead()` and `getCurrentRemoteContent()` for artifact paths — it uses a SHA-256 `contentHash` stored in the snapshot to detect local changes, and checks heads to detect remote changes. If neither changed, the artifact is skipped entirely. The `contentHash` field on `SnapshotFileEntry` is optional and only populated for artifact files.
- **Artifact directories are always nuked.** `batchUpdateDirectory` uses a plain `dirHandle.change()` (not `changeWithOptionalHeads`) for artifact directory paths and rebuilds the entire `docs` array from scratch. This avoids `changeAt` forking from stale heads, which previously caused bugs like deleted entries resurrecting. The rebuild reads the current entries, applies all changes (deletes, updates, additions, subdir URL updates), then splices out the old array and pushes the computed entries.
- **Sync timeout recovery.** `waitForSync()` returns `{ failed: DocHandle[] }` instead of throwing. When documents fail to sync (timeout or unavailable), `recreateFailedDocuments()` creates new Automerge docs with the same content, updates snapshot entries and parent directory references, then retries once. If documents still fail after recreation, it's reported as an error (not a warning) so the sync shows as "PARTIAL" rather than "SYNCED".
- **Document availability during clone.** `repo.find()` rejects with "Document X is unavailable" if the sync server doesn't have the document yet. `DocHandle.doc()` is synchronous and throws if the handle isn't ready. For clone scenarios, `sync()` retries `repo.find()` for the root document with exponential backoff (up to 6 attempts). `ChangeDetector.findDocument()` wraps `repo.find()` + `doc()` with retry logic for all document fetches during change detection.
- **Server load.** `enableRemoteHeadsGossiping` is disabled — pushwork syncs directly with the server so the gossip protocol is unnecessary overhead. `waitForSync` processes documents in batches of 10 (`SYNC_BATCH_SIZE`) to avoid flooding the server with concurrent sync messages. Without batching, syncing 100+ documents simultaneously can overwhelm the sync server (which is single-threaded with no backpressure).
- **`waitForBidirectionalSync` on large trees.** Full tree traversal (`getAllDocumentHeads`) is expensive because it `repo.find()`s every document. For post-push stabilization, pass the `handles` option to only check documents that actually changed. The initial pre-pull call still needs the full scan to discover remote changes. The dynamic timeout adds the first scan's duration on top of the base timeout, since the first scan is just establishing baseline — its duration shouldn't count against stability-wait time.
- **Versioned URLs and `repo.find()`.** `repo.find(versionedUrl)` returns a view handle whose `.heads()` returns the VERSION heads, not the current document heads. Always use `getPlainUrl()` when you need the current/mutable state. The snapshot head update loop at the end of `sync()` must use `getPlainUrl(snapshotEntry.url)` — without this, artifact directories (which store versioned URLs) get stale heads written to the snapshot, causing `changeAt()` to fork from the wrong point on the next sync. This was the root cause of the artifact deletion resurrection bug: `batchUpdateDirectory` would `changeAt` from an empty directory state where the file entry didn't exist yet, so the splice found nothing to delete.

## Subduction sync backend (`--sub`)

The `--sub` flag switches from the default WebSocket sync adapter to the Subduction backend built into `automerge-repo@2.6.0-subduction.14`. The Repo manages a `SubductionSource` internally — pushwork just passes `subductionWebsocketEndpoints` and the Repo handles connection management, sync, and retries.

### How it works

- `repo-factory.ts`: Initializes Subduction Wasm via ESM dynamic import, then creates Repo. When `sub: true`, passes `subductionWebsocketEndpoints: [syncServer]` and the Repo handles sync cadence internally. When `sub: false`, uses the traditional WebSocket network adapter instead.
- Default server: `wss://subduction.sync.inkandswitch.com` (vs `wss://sync3.automerge.org` for WebSocket)
- `network-sync.ts`: When no `StorageId` is provided (Subduction mode), `waitForSync` falls back to head-stability polling (3 consecutive stable checks at 100ms intervals) instead of `getSyncInfo`-based verification
- `sync-engine.ts`: In sub mode, skips `recreateFailedDocuments` — SubductionSource has its own heal-sync retry logic
- Everything else (push/pull phases, artifact handling, `nukeAndRebuildDocs`, change detection) is identical

### Wasm initialization

As of `automerge-repo@2.6.0-subduction.14`, the Repo constructor _always_ creates a `SubductionSource` internally (even without Subduction endpoints), which imports `MemorySigner` and `set_subduction_logger` from `@automerge/automerge-subduction/slim`. The `/slim` entry does NOT auto-init the Wasm — so Wasm must be initialized before _any_ `new Repo()` call, including the default WebSocket path.

`automerge-repo` exports `initSubduction()` which dynamically imports `@automerge/automerge-subduction` (the non-`/slim` entry that auto-inits Wasm). Pushwork calls this via `repoMod.initSubduction()` after loading the Repo module — no direct dependency on `@automerge/automerge-subduction` is needed.

`repo-factory.ts` uses a `new Function("specifier", "return import(specifier)")` wrapper to perform _real_ ESM `import()` calls that Node.js evaluates as ESM. This is necessary because TypeScript with `"module": "commonjs"` compiles `await import("x")` to `require("x")`, which resolves CJS entries. The CJS and ESM module graphs have separate Wasm instances, so initializing via CJS `require()` doesn't help the ESM `/slim` imports inside `automerge-repo`. The `new Function` trick bypasses tsc's transformation and shares the same ESM module graph as the Repo's internal imports.

The Repo class itself is also loaded via this ESM dynamic import (cached after first call) so that `new Repo()` sees the initialized Wasm module.

### Packaging notes

- `automerge-repo@2.6.0-subduction.14` correctly pins `@automerge/automerge-subduction@0.7.0` — no pnpm override needed (unlike subduction.7 which required an override to fix a version mismatch).
- `RepoConfig` properly types the Subduction options pushwork uses (`subductionWebsocketEndpoints`, `signer`, `subductionPolicy`, `subductionAdapters`) — no `as any` cast needed.
- The `automerge-repo-network-websocket` adapter's `NetworkAdapter` types are slightly behind the repo's `NetworkAdapterInterface` (missing `state()` method in declarations). The adapter works at runtime; the type mismatch is worked around with `as unknown as NetworkAdapterInterface`.
- New `"heal-exhausted"` event on Repo fires when self-healing sync gives up after all retry attempts for a document. Not currently used by pushwork but available for better error reporting.

### Subduction mode persistence

`--sub` is only accepted on `init` and `clone`. It persists `subduction: true` in `.pushwork/config.json`. All subsequent commands (`sync`, `watch`, etc.) read it from config via `config.subduction ?? false`. The force-defaults path in `setupCommandContext` preserves `subduction` alongside `root_directory_url`.

When Subduction mode is active, commands print a banner: "Using Subduction sync backend (from config)".

Every `sync` run prints the root Automerge URL at the end.

### Corrupt storage recovery

`repo-factory.ts` scans `.pushwork/automerge/` for 0-byte files before creating the Repo. These indicate incomplete writes from a previous run (process exited before storage flushed). If any are found, the entire automerge cache is wiped and recreated — data will re-download from the sync server. The snapshot (`.pushwork/snapshot.json`) is preserved so all document URLs are retained.

This is a safety net for the Subduction `HydrationError: LooseCommit too short` crash. The upstream fix (`Repo.shutdown()` now calls `flush()` and `SubductionSource.shutdown()` awaits pending writes) prevents the corruption from happening in the first place, but edge cases (SIGKILL, OOM, power loss) can still produce 0-byte files.
