# Automerge Directory Sync - Design Document

## Overview

A bidirectional file synchronization system that keeps a local directory in sync with a set of Automerge documents. Files can be edited locally or remotely, with automatic conflict resolution provided by Automerge's CRDT capabilities.

## Architecture

### Document Schema

**Directory Document:**

```typescript
{
  docs: [
    {
      name: "filename.txt",
      type: "file",
      url: AutomergeUrl, // Points to file document
    },
    {
      name: "subdir",
      type: "folder",
      url: AutomergeUrl, // Points to subdirectory document
    },
  ];
}
```

**File Document:**

```typescript
{
  name: "filename.txt",
  extension: "txt",
  mimeType: "text/plain",
  contents: Text("file content") | Uint8Array(...),  // Type determines binary vs text
  metadata: {
    permissions: 0o644
  }
}
```

### Local State Management

**Sync Snapshot:**

```typescript
{
  timestamp: number,
  rootPath: string,
  files: Map<string, {
    path: string,  // Full filesystem path for mapping
    url: AutomergeUrl,
    head: string,
    extension: string,
    mimeType: string
  }>,
  directories: Map<string, {
    path: string,  // Full filesystem path for mapping
    url: AutomergeUrl,
    head: string,
    entries: string[]
  }>
}
```

The snapshot captures the exact state of both filesystem and Automerge documents after each successful sync, enabling reliable change detection.

## Core Sync Logic

### Two-Phase Bidirectional Sync

**Phase 1: Push Local Changes**

1. Compare current filesystem state against local snapshot
2. Detect changes: creates, deletes, modifications, moves, type changes
3. Apply all local changes to Automerge documents using `.changeAt(lastSnapshotHeads, ...)` to preserve proper causality
4. Update snapshot incrementally as changes are applied

**Phase 2: Pull Remote Changes**

1. Compare current remote document state against snapshot expectations
2. Build task list of remote operations needed locally
3. Execute tasks in dependency order (parents before children)
4. Update snapshot incrementally as tasks complete

### Change Detection

**Content-Based Detection:**

- Use Automerge document heads from snapshot as "last known state"
- Compare local file content against content at those heads
- No reliance on filesystem timestamps or separate content hashes

**Change Classification:**

- `NoChange`: local == lastKnown == remote
- `LocalOnly`: local != lastKnown, remote == lastKnown
- `RemoteOnly`: local == lastKnown, remote != lastKnown
- `BothChanged`: local != lastKnown, remote != lastKnown

### Move Detection

**Strategy:** Pair deleted files with created files based on content similarity

**Algorithm:**

1. Identify deleted files (in snapshot, not in current filesystem)
2. Identify created files (in current filesystem, not in snapshot)
3. For each deleted file, load its content from Automerge at snapshot head
4. Compare with content of each created file
5. Pair files above similarity threshold (0.8 for auto-apply, 0.5+ for user prompt)

**Similarity Scoring:**

- Small files: exact content comparison
- Large files: sample first/last/middle chunks
- Account for size differences and content type

### File Type Changes

When a path changes type (text↔binary↔directory):

1. Create new document with correct type and contents
2. Update parent directory's `docs` array to point to new AutomergeUrl
3. Orphan old document (let Automerge garbage collect)

**File Type Detection:**

- Binary files: `contents` is `Uint8Array`
- Text files: `contents` is Automerge `Text` object or string
- File extension stored separately in `extension` field for convenience

**File Type Detection:**

- Binary files: `contents` is `Uint8Array`
- Text files: `contents` is Automerge `Text` object or string
- File extension stored separately in `extension` field for convenience

## Error Handling & Recovery

### Incremental Progress Strategy

**Core Principle:** Update local snapshot after each successful operation

**Benefits:**

- Resumable syncs after interruption
- Partial progress preserved
- Simple recovery - just run sync again
- Snapshot always reflects actual state

**Error Categories:**

- **Network failures**: Retry, resume where left off
- **Filesystem errors**: Skip problematic files, continue with others
- **Permission errors**: Log and continue, report at end
- **Critical failures**: Bail out but preserve progress made

### Recovery Scenarios

**Interrupted sync:** Next sync compares current state vs. updated snapshot, processes only remaining differences

**Network partition:** Phase 1 completes locally, Phase 2 resumes when connectivity returns

**Filesystem errors:** Failed operations appear as "still pending" in next sync attempt

## CLI Interface

### Commands

**sync-tool init \<path\> [\--remote=\<repo-id\>]**

- Initialize sync in directory
- Create initial Automerge documents
- Set up local state tracking

**sync-tool sync [\--dry-run]**

- Run full bidirectional sync
- With --dry-run: show what would be done without applying changes

**sync-tool diff [\--tool=\<external-tool\>] [\<path\>]**

- Show local changes since last sync
- Materializes snapshot state and runs standard diff
- Optional external tool support (meld, beyond compare, etc.)

**sync-tool status**

- Show sync state summary
- Pending changes, last sync time, conflict indicators

**sync-tool log [\--oneline] [\<path\>]**

- Show sync history
- Per-file history with --path option

**sync-tool checkout \<sync-id\> [\<path\>]**

- Restore directory to state from previous sync
- Limited to sync boundaries (not arbitrary timestamps)

### Configuration

**Global config:** `~/.sync-tool/config`

```toml
[defaults]
exclude_patterns = [".git", "node_modules", "*.tmp"]
large_file_threshold = "100MB"

[diff]
external_tool = "meld"
show_binary = false

[sync]
move_detection_threshold = 0.8
prompt_threshold = 0.5
```

**Per-directory config:** `<directory>/.sync-tool/config`

- Overrides global settings
- Repository-specific settings

## Implementation Notes

### Performance Considerations

**Large Files:**

- Stream content for files over threshold
- Progress reporting for operations
- Chunked uploads/downloads

**Many Files:**

- Batch document operations
- Parallel filesystem operations where safe
- Incremental sync for large directories

**Network Usage:**

- Leverage Automerge-Repo's network efficiency
- Only sync changed documents
- Background sync option

### Future Enhancements

**Branches:** When Automerge supports branches, enable:

- True pull-only operations
- Local work isolation
- Git-like merge workflows

**History:** Enhanced history browsing:

- Cross-document temporal queries
- Visual timeline interface
- Conflict resolution history

**Collaboration:**

- Multi-user attribution
- Access controls
- Real-time collaboration indicators

---

# sync-tool(1) Manual Page

## NAME

sync-tool - bidirectional directory synchronization using Automerge CRDTs

## SYNOPSIS

**sync-tool** _command_ [*options*] [*path*]

## DESCRIPTION

sync-tool keeps a local directory synchronized with Automerge documents, enabling conflict-free collaboration across multiple devices and users. Files can be edited locally or remotely with automatic merge resolution.

## COMMANDS

### sync-tool init [--remote=REPO] PATH

Initialize sync in directory PATH. Creates Automerge documents for existing files and sets up local state tracking.

**Options:**

- `--remote=REPO` - Specify remote Automerge repository ID

### sync-tool sync [--dry-run]

Run full bidirectional synchronization. Pushes local changes and pulls remote changes.

**Options:**

- `--dry-run` - Show what would be done without applying changes

### sync-tool diff [--tool=TOOL] [--name-only] [PATH]

Show changes in working directory since last sync.

**Options:**

- `--tool=TOOL` - Use external diff tool (meld, vimdiff, etc.)
- `--name-only` - Show only changed file names
- `PATH` - Limit diff to specific path

### sync-tool status

Show sync status summary including pending changes and last sync time.

### sync-tool log [--oneline] [PATH]

Show sync history. With PATH, show history for specific file or directory.

**Options:**

- `--oneline` - Compact one-line per sync format

### sync-tool checkout SYNC-ID [PATH]

Restore directory to state from previous sync identified by SYNC-ID.

## CONFIGURATION

### Global: ~/.sync-tool/config

```toml
[defaults]
remote_repo = "repo-id"
exclude_patterns = [".git", "*.tmp"]

[diff]
external_tool = "meld"

[sync]
move_detection_threshold = 0.8
```

### Per-directory: .sync-tool/config

Repository-specific overrides of global configuration.

## FILES

- `~/.sync-tool/config` - Global configuration
- `<directory>/.sync-tool/config` - Per-directory configuration
- `<directory>/.sync-tool/snapshot` - Local sync state
- `<directory>/.sync-tool/history/` - Sync history storage

## EXAMPLES

Initialize sync in current directory:

```bash
sync-tool init . --remote=abc123
```

Show local changes:

```bash
sync-tool diff
sync-tool diff --tool=meld src/
```

Sync with remote:

```bash
sync-tool sync
sync-tool sync --dry-run  # preview changes
```

View history and restore:

```bash
sync-tool log
sync-tool checkout sync-456 important.txt
```

## EXIT STATUS

- 0 - Success
- 1 - General error
- 2 - Configuration error
- 3 - Network error
- 4 - Filesystem error
- 5 - Conflict requires manual resolution

## SEE ALSO

git(1), rsync(1), unison(1)

## AUTHORS

Written for Automerge-based distributed collaboration.
