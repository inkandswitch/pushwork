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
- `pushwork sync [path]` - Full bidirectional sync
  - `--dry-run` - Preview only
  - `--force` - Use default config, reset snapshot, re-sync every file
  - `--force --nuclear` - Also recreate all Automerge documents from scratch (except root)
- `pushwork push [path]` - Push local changes to server without pulling remote changes
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
- `pushToRemote()` does detect + push + `waitForSync` only (no bidirectional wait, no pull) - used by `push` command

## Leaf-first ordering

`pushLocalChanges()` processes directories deepest-first via `batchUpdateDirectory()`, propagating subdirectory URL updates as it walks up toward the root. This ensures directory entries always point to the latest version of their children.

## The `changeWithOptionalHeads` helper

Used throughout sync-engine: if heads are available, calls `handle.changeAt(heads, cb)` to branch from a known version; otherwise falls back to `handle.change(cb)`. This is important for conflict-free merging when multiple peers are editing.

## Performance pitfalls

- **Avoid splicing large text deletions.** Automerge text CRDTs track every character as an individual op. `A.splice(doc, path, 0, largeString.length)` to clear a large file is O(n) in CRDT ops and very slow. This is why `deleteRemoteFile()` no longer clears content — it just lets the document become orphaned when removed from its parent directory.
- **Avoid diffing artifact files.** `diffChars()` is O(n*m) and pointless for artifact directories since they use RawString (immutable snapshots). Artifact files should always be replaced with a fresh document rather than diffed+spliced. This applies to `updateRemoteFile()`, `applyMoveToRemote()`, and change detection. `ChangeDetector` skips `getContentAtHead()` and `getCurrentRemoteContent()` for artifact paths — it uses a SHA-256 `contentHash` stored in the snapshot to detect local changes, and checks heads to detect remote changes. If neither changed, the artifact is skipped entirely. The `contentHash` field on `SnapshotFileEntry` is optional and only populated for artifact files.
- **`waitForBidirectionalSync` on large trees.** Full tree traversal (`getAllDocumentHeads`) is expensive because it `repo.find()`s every document. For post-push stabilization, pass the `handles` option to only check documents that actually changed. The initial pre-pull call still needs the full scan to discover remote changes. The dynamic timeout adds the first scan's duration on top of the base timeout, since the first scan is just establishing baseline — its duration shouldn't count against stability-wait time.
