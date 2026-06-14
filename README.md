# Pushwork

Bidirectional file synchronization using Automerge CRDTs for conflict-free collaborative editing.

## Features

- **Conflict-Free Sync**: Automatic conflict resolution using Automerge CRDTs
- **Real-time Collaboration**: Multiple users can edit the same files simultaneously
- **Intelligent Move Detection**: Detects file renames and moves based on content similarity
- **Offline Support**: Works offline and gracefully handles network interruptions
- **Cross-Platform**: Runs on Windows, macOS, and Linux

## Installation

```bash
pnpm install
pnpm run build
pnpm link --global
```

Requires: Node.js 24+, pnpm 8+

## Quick Start

```bash
# Initialize a directory
pushwork init ./my-project

# Clone an existing repository
pushwork clone <automerge-url> ./project

# Sync changes
pushwork sync

# Check status
pushwork status

# Get shareable URL
pushwork url
```

## Commands

### Global Output Flags

Available on every command:

- `--porcelain` - Machine-readable output: tab-separated `<level>\t<message>`
  lines, no spinners, colors, or prompts. Use this when scripting.
- `-q, --quiet` - Suppress progress; show only final summaries and errors
- `--silent` - Suppress everything except errors (sent to stderr); rely on
  exit codes

The default is an interactive UI with spinners and confirmation prompts.
Prompts automatically accept their default answer when any of these flags
are set or when not attached to a terminal, so scripts and CI never hang.
Data outputs (`url`, `ls`, `diff --name-only` paths) are always plain lines
in every mode.

### Core Commands

**`init [path]`** - Initialize sync in a directory

- `--sync-server <url> [storage-id]` - Custom sync server URL. A storage ID is only valid with `--legacy`; passing one in the default Subduction mode is an error.
- `--legacy` - Use the legacy WebSocket sync backend (Subduction is default)

**`clone <url> <path>`** - Clone an existing synced directory

- `--force` - Overwrite existing directory
- `--sync-server <url> [storage-id]` - Custom sync server URL. A storage ID is only valid with `--legacy`; passing one in the default Subduction mode is an error.
- `--legacy` - Use the legacy WebSocket sync backend (Subduction is default)

**`sync [path]`** - Run bidirectional synchronization

- `--dry-run` - Preview changes without applying
- `--gentle` - Use config files and only sync changed files (instead of the default full resync)
- `--nuclear` - Recreate all Automerge documents from scratch
- `--verbose` - Show detailed progress

**`status [path]`** - Show sync status and repository info

- `--verbose` - Show detailed status including all tracked files

**`commit [path]`** - Commit local changes to Automerge documents without network sync

### Utility Commands

**`diff [path]`** - Show differences between local and remote

- `--name-only` - Show only changed file names

**`url [path]`** - Show the Automerge root URL for sharing

**`ls [path]`** - List tracked files

- `-v, --verbose` - Show Automerge URLs

**`config [path]`** - View or edit configuration

- `--list` - Show full configuration
- `--get <key>` - Get specific config value (dot notation)

**`rm [path]`** - Remove local pushwork data

**`watch [path]`** - Watch directory, build, and sync automatically

- `--script <command>` - Build script (default: "pnpm build")
- `--dir <dir>` - Directory to watch (default: "src")
- `--verbose` - Show build output

**`log [path]`** - Show sync history _(experimental, limited functionality)_

**`checkout <sync-id> [path]`** - Restore to previous sync _(not yet implemented)_

## Configuration

Configuration is stored in `.pushwork/config.json`:

```json
{
  "config_version": 1,
  "protocol": "subduction",
  "sync_server": "wss://subduction.sync.inkandswitch.com",
  "sync_enabled": true,
  "exclude_patterns": [".git", "node_modules", ".pnpm-store", "target", "__pycache__", ".venv", "*.tmp", ".pushwork"],
  "artifact_directories": ["dist"],
  "sync": {
    "move_detection_threshold": 0.7
  }
}
```

A legacy-backend config looks like:

```json
{
  "config_version": 1,
  "protocol": "legacy",
  "sync_server": "wss://sync3.automerge.org",
  "sync_server_storage_id": "3760df37-a4c6-4f66-9ecd-732039a9385d",
  "sync_enabled": true,
  "exclude_patterns": [".git", "node_modules", ".pnpm-store", "target", "__pycache__", ".venv", "*.tmp", ".pushwork"],
  "artifact_directories": ["dist"],
  "sync": {
    "move_detection_threshold": 0.7
  }
}
```

The `exclude_patterns` shown above are abbreviated. By default pushwork
excludes version-control metadata and the large machine-generated
directories of the common ecosystems — dependency stores (`node_modules`,
`.pnpm-store`, `.yarn/cache`), build output (`target`, `dist-newstyle`,
`_build`, `result`), and tool caches (`__pycache__`, `.venv`,
`.pytest_cache`, `.gradle`, `.terraform`, …). Patterns use full
`.gitignore` semantics, so a bare name like `target` matches at any depth.
Set your own `exclude_patterns` to override the list entirely.

> [!NOTE]
> `pushwork sync` runs in _force mode_: it resets `exclude_patterns` (and
> other non-backend settings) to the built-in defaults each run. To sync
> with a customized exclude list, use `pushwork sync --gentle`, which
> honors your `.pushwork/config.json`.

### Sync Backends

Pushwork supports two sync backends. Subduction is the default.

- **Subduction (default)** — `wss://subduction.sync.inkandswitch.com`.
  The backend is selected at `init` / `clone` time and persisted in
  `.pushwork/config.json` as `"protocol": "subduction"`. Subsequent
  `sync` / `watch` runs read the choice from config.
- **Legacy WebSocket** — opt in via `--legacy` on `init` or `clone` to
  use `wss://sync3.automerge.org` with `sync_server_storage_id` for
  delivery verification. Persisted as `"protocol": "legacy"`.

### Config schema version

Configs written by current pushwork include `"config_version": 1`.
Older configs (without this field) are automatically migrated on the
next write-ish command (`sync`, `watch`, `commit`, `init`, `clone`,
`track`). The original v0 file is saved as `config.json.bak` (or
`config.json.bak.1`, `.bak.2`, ... if earlier backups exist) and a
notice is printed.

Migration inference:

- v0 config with `"subduction": true`  → `"protocol": "subduction"`
- v0 config with `"subduction": false` → `"protocol": "legacy"`
- v0 config with no `subduction` key   → `"protocol": "legacy"` (this
  matches pre-Subduction installs that were already using the
  WebSocket relay)

## How It Works

Pushwork uses Automerge CRDTs for automatic conflict resolution:

- **Text files**: Character-level merging preserves all changes
- **Binary files**: Last-writer-wins with automatic convergence
- **Directories**: Additive merging supports simultaneous file creation

Sync process:

1. **Push**: Apply local changes to Automerge documents
2. **Pull**: Apply remote changes to local filesystem
3. **Convergence**: All repositories reach identical state

State tracking:

- `.pushwork/snapshot.json` - Tracks sync state and file mappings
- `.pushwork/config.json` - Configuration settings
- Content-based change detection using Automerge document heads

### Document Schema

**File Document:**

```typescript
{
  "@patchwork": { type: "file" };
  name: string;
  extension: string;
  mimeType: string;
  content: string | Uint8Array;
  metadata: {
    permissions: number;
  };
}
```

**Directory Document:**

```typescript
{
  "@patchwork": { type: "folder" };
  docs: Array<{
    name: string;
    type: "file" | "folder";
    url: AutomergeUrl;
  }>;
  lastSyncAt?: number;
}
```

## Development

### Setup

```bash
git clone <repository-url>
cd pushwork
pnpm install
pnpm run build
pnpm run dev          # Watch mode
pnpm test             # Run tests
pnpm run test:watch   # Watch mode for tests
```

### Project Structure

```
src/
├── cli.ts        # CLI entry point (Commander.js)
├── commands.ts   # Command implementations
├── index.ts      # Public library API
├── core/         # Sync engine, change/move detection, snapshot, config
├── types/        # TypeScript type definitions
└── utils/        # Filesystem, MIME, network sync, output, repo factory, ...
```

### Testing

```bash
pnpm test                                              # Unit tests
./test/run-tests.sh                                    # All integration tests
./test/integration/conflict-resolution-test.sh         # Specific test
```

### Profiling

```bash
clinic flame --collect-only -- node --enable-source-maps --prof $(pnpm root -g)/pushwork/dist/cli.js sync
```

## License

MIT License
