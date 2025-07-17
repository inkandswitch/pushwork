# Sync Tool

A bidirectional file synchronization system using Automerge CRDTs for conflict-free collaboration.

## Features

- **Bidirectional Sync**: Keep local directories in sync with Automerge documents
- **Conflict-Free**: Automatic conflict resolution using Automerge CRDTs
- **Move Detection**: Intelligent detection of file moves based on content similarity
- **Incremental Sync**: Only sync changed files for efficiency
- **Cross-Platform**: Works on Windows, macOS, and Linux
- **CLI Interface**: Full-featured command-line interface

## Installation

```bash
npm install -g sync-tool
```

## Quick Start

1. Initialize sync in a directory:

```bash
sync-tool init . --remote=your-repo-id
```

2. Run initial sync:

```bash
sync-tool sync
```

3. Check status:

```bash
sync-tool status
```

## Commands

### `sync-tool init <path> --remote=<repo-id>`

Initialize sync in a directory with a remote Automerge repository.

```bash
sync-tool init ./my-project --remote=abc123def456
```

### `sync-tool sync [--dry-run]`

Run bidirectional synchronization.

```bash
# Preview changes without applying
sync-tool sync --dry-run

# Apply changes
sync-tool sync
```

### `sync-tool diff [path] [--tool=<tool>] [--name-only]`

Show differences between local and remote state.

```bash
# Show all changes
sync-tool diff

# Show changes for specific path
sync-tool diff src/

# Use external diff tool
sync-tool diff --tool=meld

# Show only changed file names
sync-tool diff --name-only
```

### `sync-tool status`

Show sync status and pending changes.

```bash
sync-tool status
```

### `sync-tool log [path] [--oneline]`

Show sync history.

```bash
# Show full history
sync-tool log

# Compact format
sync-tool log --oneline

# History for specific path
sync-tool log src/important-file.txt
```

### `sync-tool checkout <sync-id> [path]`

Restore files to state from previous sync.

```bash
# Restore entire directory
sync-tool checkout sync-123

# Restore specific file
sync-tool checkout sync-123 important-file.txt
```

## Configuration

### Global Configuration

Located at `~/.sync-tool/config.json`:

```json
{
  "defaults": {
    "exclude_patterns": [".git", "node_modules", "*.tmp"],
    "large_file_threshold": "100MB"
  },
  "diff": {
    "external_tool": "meld",
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

### Per-Directory Configuration

Located at `<directory>/.sync-tool/config.json`:

```json
{
  "remote_repo": "your-repo-id",
  "sync_enabled": true,
  "defaults": {
    "exclude_patterns": [".env", "dist/"]
  }
}
```

## How It Works

### Two-Phase Sync

1. **Push Phase**: Apply local changes to Automerge documents
2. **Pull Phase**: Apply remote changes to local filesystem

### Change Detection

- Content-based comparison using Automerge document heads
- No reliance on file timestamps
- Detects creates, updates, deletes, and moves

### Move Detection

- Compares content similarity between deleted and created files
- Auto-applies moves above 80% similarity
- Prompts user for moves between 50-80% similarity
- Configurable thresholds

### Conflict Resolution

- Automerge CRDTs provide automatic conflict resolution
- Text files: line-by-line merging
- Binary files: last-writer-wins with conflict markers
- Directory structure: additive merging

## Architecture

### Document Schema

**File Document:**

```typescript
{
  name: string;
  extension: string;
  mimeType: string;
  contents: Text | Uint8Array;
  metadata: {
    permissions: number;
  }
}
```

**Directory Document:**

```typescript
{
  docs: Array<{
    name: string;
    type: "file" | "folder";
    url: AutomergeUrl;
  }>;
}
```

### Local State

- Snapshot tracking at `.sync-tool/snapshot.json`
- Maps filesystem paths to Automerge document URLs and heads
- Enables efficient change detection and resumable syncs

## Development

### Prerequisites

- Node.js 18+
- TypeScript 5+

### Setup

```bash
git clone https://github.com/your-org/sync-tool
cd sync-tool
npm install
npm run build
```

### Testing

```bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# Coverage
npm run test:coverage
```

### Building

```bash
npm run build
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

- Issues: [GitHub Issues](https://github.com/your-org/sync-tool/issues)
- Documentation: [Wiki](https://github.com/your-org/sync-tool/wiki)
- Community: [Discussions](https://github.com/your-org/sync-tool/discussions)
