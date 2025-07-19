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
npm install -g pushwork
```

## Quick Start

1. Initialize sync in a directory:

```bash
pushwork init . --remote=your-repo-id
```

2. Run initial sync:

```bash
pushwork sync
```

3. Check status:

```bash
pushwork status
```

## Commands

### `pushwork init <path> --remote=<repo-id>`

Initialize sync in a directory with a remote Automerge repository.

```bash
pushwork init ./my-project --remote=abc123def456
```

### `pushwork sync [--dry-run]`

Run bidirectional synchronization.

```bash
# Preview changes without applying
pushwork sync --dry-run

# Apply changes
pushwork sync
```

### `pushwork diff [path] [--tool=<tool>] [--name-only]`

Show differences between local and remote state.

```bash
# Show all changes
pushwork diff

# Show changes for specific path
pushwork diff src/

# Use external diff tool
pushwork diff --tool=meld

# Show only changed file names
pushwork diff --name-only
```

### `pushwork status`

Show sync status and pending changes.

```bash
pushwork status
```

### `pushwork log [path] [--oneline]`

Show sync history.

```bash
# Show full history
pushwork log

# Compact format
pushwork log --oneline

# History for specific path
pushwork log src/important-file.txt
```

### `pushwork checkout <sync-id> [path]`

Restore files to state from previous sync.

```bash
# Restore entire directory
pushwork checkout sync-123

# Restore specific file
pushwork checkout sync-123 important-file.txt
```

## Configuration

### Global Configuration

Located at `~/.pushwork/config.json`:

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

Located at `<directory>/.pushwork/config.json`:

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

- Snapshot tracking at `.pushwork/snapshot.json`
- Maps filesystem paths to Automerge document URLs and heads
- Enables efficient change detection and resumable syncs

## Development

### Prerequisites

- Node.js 18+
- TypeScript 5+

### Setup

```bash
git clone https://github.com/your-org/pushwork
cd pushwork
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

- Issues: [GitHub Issues](https://github.com/your-org/pushwork/issues)
- Documentation: [Wiki](https://github.com/your-org/pushwork/wiki)
- Community: [Discussions](https://github.com/your-org/pushwork/discussions)
