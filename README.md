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

Requires: Node.js 18+, pnpm 8.15.0+

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

### Core Commands

**`init [path]`** - Initialize sync in a directory

- `--sync-server <url>` - Custom sync server URL
- `--sync-server-storage-id <id>` - Custom storage ID
- `--debug` - Export performance flame graphs

**`clone <url> <path>`** - Clone an existing synced directory

- `--force` - Overwrite existing directory
- `--sync-server <url>` - Custom sync server URL
- `--sync-server-storage-id <id>` - Custom storage ID

**`sync [path]`** - Run bidirectional synchronization

- `--dry-run` - Preview changes without applying
- `--verbose` - Show detailed progress
- `--debug` - Export performance flame graphs

**`status [path]`** - Show sync status and repository info

- `--verbose` - Show detailed status including all tracked files

**`commit [path]`** - Commit local changes without network sync

- `--dry-run` - Preview what would be committed
- `--debug` - Export performance flame graphs

### Utility Commands

**`diff [path]`** - Show differences between local and remote

- `--name-only` - Show only changed file names

**`url [path]`** - Show the Automerge root URL for sharing

**`ls [path]`** - List tracked files

- `--long` - Show Automerge URLs

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
  "sync_server": "wss://sync3.automerge.org",
  "sync_server_storage_id": "3760df37-a4c6-4f66-9ecd-732039a9385d",
  "sync_enabled": true,
  "defaults": {
    "exclude_patterns": [".git", "node_modules", "*.tmp", ".pushwork"],
    "large_file_threshold": "100MB"
  },
  "diff": {
    "show_binary": false
  },
  "sync": {
    "move_detection_threshold": 0.8,
    "prompt_threshold": 0.5,
    "auto_sync": false,
    "parallel_operations": 4
  }
}
```

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
  content: ImmutableString | Uint8Array;
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
├── cli/        # Command-line interface
├── core/       # Core sync engine
├── config/     # Configuration management
├── tracing/    # Performance tracing
├── types/      # TypeScript type definitions
└── utils/      # Shared utilities
```

### Testing

```bash
pnpm test                                              # Unit tests
./test/run-tests.sh                                    # All integration tests
./test/integration/conflict-resolution-test.sh         # Specific test
```

### Profiling

```bash
pushwork sync --debug                                  # Export flame graphs
clinic flame -- node $(pnpm root -g)/pushwork/dist/cli.js sync
```

## License

MIT License
