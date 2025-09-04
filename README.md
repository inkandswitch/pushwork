# Pushwork

A bidirectional file synchronization system using Automerge CRDTs for conflict-free collaborative editing.

## Overview

Pushwork enables real-time collaboration on directories and files using **Conflict-free Replicated Data Types (CRDTs)**. Unlike traditional sync tools that require manual conflict resolution, Pushwork automatically merges changes from multiple users while preserving everyone's work.

## ✨ Key Features

- **🔄 Bidirectional Sync**: Keep local directories synchronized with remote Automerge repositories
- **🚫 Conflict-Free**: Automatic conflict resolution using Automerge CRDTs - no merge conflicts ever
- **📱 Real-time Collaboration**: Multiple users can edit the same files simultaneously
- **🧠 Intelligent Move Detection**: Detects file renames and moves based on content similarity
- **⚡ Incremental Sync**: Only synchronizes changed files for maximum efficiency
- **🌐 Network Resilient**: Works offline and gracefully handles network interruptions
- **🖥️ Cross-Platform**: Runs on Windows, macOS, and Linux
- **🛠️ Rich CLI**: Full-featured command-line interface with comprehensive tooling

## 🚀 Quick Start

### Installation

Currently, install from source:

```bash
pnpm install
pnpm run build
pnpm link
```

These steps require pnpm v10.

### Basic Usage

1. **Initialize a new repository:**

```bash
pushwork init ./my-project
```

2. **Clone an existing repository:**

```bash
pushwork clone <automerge-url> ./cloned-project
```

3. **Sync changes:**

```bash
pushwork sync
```

4. **Check status:**

```bash
pushwork status
```

## 📚 Commands

### `init <path> [options]`

Initialize sync in a directory, creating a new Automerge repository.

```bash
# Initialize with default sync server
pushwork init ./my-project

# Initialize with custom sync server
pushwork init ./my-project \
  --sync-server ws://localhost:3030 \
  --sync-server-storage-id your-storage-id
```

**Options:**

- `--sync-server <url>`: Custom sync server URL (requires storage-id)
- `--sync-server-storage-id <id>`: Custom sync server storage ID (requires server)

### `clone <url> <path> [options]`

Clone an existing synced directory from an Automerge URL.

```bash
# Clone from default sync server
pushwork clone automerge:abc123... ./cloned-project

# Clone with custom sync server
pushwork clone automerge:abc123... ./cloned-project \
  --sync-server ws://localhost:3030 \
  --sync-server-storage-id your-storage-id

# Force overwrite existing directory
pushwork clone automerge:abc123... ./existing-dir --force
```

**Options:**

- `--force`: Overwrite existing directory
- `--sync-server <url>`: Custom sync server URL
- `--sync-server-storage-id <id>`: Custom sync server storage ID

### `sync [options]`

Run bidirectional synchronization between local files and remote repository.

```bash
# Preview changes without applying them
pushwork sync --dry-run

# Apply all changes
pushwork sync

# Verbose output
pushwork sync --verbose
```

**Options:**

- `--dry-run`: Preview changes without applying them
- `--verbose`: Show detailed progress information

### `diff [path] [options]`

Show differences between local and remote state.

```bash
# Show all changes
pushwork diff

# Show changes for specific path
pushwork diff src/

# Show only changed file names
pushwork diff --name-only

# Use external diff tool
pushwork diff --tool meld
```

**Options:**

- `--tool <tool>`: Use external diff tool (meld, vimdiff, etc.)
- `--name-only`: Show only changed file names

### `status`

Show current sync status and repository information.

```bash
pushwork status
```

### `log [path] [options]`

Show sync history for the repository or specific files.

```bash
# Show repository history
pushwork log

# Compact one-line format
pushwork log --oneline

# History for specific path
pushwork log src/important-file.txt
```

**Options:**

- `--oneline`: Compact one-line per sync format
- `--since <date>`: Show syncs since date
- `--limit <n>`: Limit number of syncs shown (default: 10)

### `url [path]`

Show the Automerge root URL for sharing with others.

```bash
# Get URL for current directory
pushwork url

# Get URL for specific directory
pushwork url ./my-project
```

### `commit [path] [options]`

Commit local changes without network sync (useful for offline work).

```bash
# Commit all changes
pushwork commit

# Preview what would be committed
pushwork commit --dry-run

# Commit specific directory
pushwork commit ./src
```

**Options:**

- `--dry-run`: Show what would be committed without applying changes

### `checkout <sync-id> [path] [options]`

Restore directory to state from previous sync (not yet implemented).

```bash
# Restore entire directory
pushwork checkout sync-123

# Force checkout even with uncommitted changes
pushwork checkout sync-123 --force
```

## ⚙️ Configuration

### Default Configuration

Pushwork uses sensible defaults:

- **Sync Server**: `wss://sync3.automerge.org`
- **Storage ID**: `3760df37-a4c6-4f66-9ecd-732039a9385d`
- **Excluded Patterns**: `.git`, `node_modules`, `*.tmp`, `.pushwork`
- **Large File Threshold**: 100MB
- **Move Detection Threshold**: 80% similarity

### Directory Configuration

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

## 🔧 How It Works

### CRDT-Based Conflict Resolution

Pushwork uses **Automerge CRDTs** to automatically resolve conflicts:

- **Text Files**: Character-level merging preserves all changes
- **Binary Files**: Last-writer-wins with automatic convergence
- **Directory Structure**: Additive merging supports simultaneous file creation
- **File Moves**: Intelligent detection prevents data loss during renames

### Two-Phase Sync Process

1. **Push Phase**: Apply local changes to Automerge documents
2. **Pull Phase**: Apply remote changes to local filesystem
3. **Convergence**: All repositories eventually reach identical state

### Change Detection

- **Content-Based**: Uses Automerge document heads, not timestamps
- **Efficient**: Only processes actually changed files
- **Reliable**: Works across time zones and file system differences
- **Resumable**: Interrupted syncs can be safely resumed

### Move Detection Algorithm

- Compares content similarity between deleted and created files
- **Auto-apply**: Moves with >80% similarity (configurable)
- **User prompt**: Moves with 50-80% similarity (configurable)
- **Ignore**: Moves with <50% similarity

## 📁 Architecture

### Document Schema

**File Document:**

```typescript
{
  "@patchwork": { type: "file" };
  name: string;
  extension: string;
  mimeType: string;
  content: Text | Uint8Array;
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
}
```

### Local State Management

- **Snapshot File**: `.pushwork/snapshot.json` tracks sync state
- **Path Mapping**: Links filesystem paths to Automerge document URLs
- **Head Tracking**: Enables efficient change detection
- **Configuration**: `.pushwork/config.json` stores sync settings

### Network Architecture

- **Sync Server**: Handles real-time synchronization between clients
- **Storage ID**: Isolates different collaboration groups
- **WebSocket Connection**: Provides real-time updates
- **Graceful Degradation**: Works offline with manual sync

## 🧪 Testing

### Running Tests

```bash
# Build the project
npm run build

# Run unit tests
npm test

# Run integration tests
./test/run-tests.sh

# Test conflict resolution
./test/integration/conflict-resolution-test.sh

# Test clone functionality
./test/integration/clone-test.sh
```

### Test Coverage

- **Unit Tests**: Core functionality and utilities
- **Integration Tests**: End-to-end sync scenarios
- **Conflict Resolution**: CRDT merging behavior
- **Clone Operations**: Repository sharing workflows

## 🛠️ Development

### Prerequisites

- Node.js 18+
- TypeScript 5+
- pnpm (recommended) or npm

### Development Setup

```bash
git clone <repository-url>
cd pushwork
npm install
npm run build

# Development mode
npm run dev

# Watch mode for testing
npm run test:watch
```

### Project Structure

```
src/
├── cli/           # Command-line interface
├── core/          # Core sync engine
├── config/        # Configuration management
├── types/         # TypeScript type definitions
└── utils/         # Shared utilities

test/
├── unit/          # Unit tests
└── integration/   # Integration tests
```

## 🤝 Real-World Collaboration Example

```bash
# Alice initializes a project
alice$ pushwork init ./shared-docs
alice$ echo "Hello World" > shared-docs/readme.txt
alice$ pushwork sync
alice$ pushwork url
# automerge:2V4w7zv8zkJYJxJsKaYhZ5NPjxA1

# Bob clones Alice's project
bob$ pushwork clone automerge:2V4w7zv8zkJYJxJsKaYhZ5NPjxA1 ./bobs-copy

# Both edit the same file simultaneously
alice$ echo "Alice's changes" >> shared-docs/readme.txt
bob$ echo "Bob's changes" >> bobs-copy/readme.txt

# Both sync - no conflicts!
alice$ pushwork sync
bob$ pushwork sync
alice$ pushwork sync  # Gets Bob's changes

# Final result contains both changes merged automatically
alice$ cat shared-docs/readme.txt
Hello World
Alice's changes
Bob's changes
```

## 🐛 Troubleshooting

### Common Issues

**WebSocket Connection Errors**: Usually safe to ignore during shutdown

**"Directory not initialized"**: Run `pushwork init .` first

**Network Sync Timeout**: Check internet connection and sync server status

**File Permission Errors**: Ensure write access to target directory

### Debug Mode

```bash
# Enable verbose logging
pushwork sync --verbose

# Preview changes without applying
pushwork sync --dry-run

# Check repository status
pushwork status
```

## 📄 License

MIT License - see LICENSE file for details.

## 🔗 Links

- **Issues**: Report bugs and request features
- **Documentation**: Additional guides and tutorials
- **Automerge**: Learn more about CRDT technology

---

**🚀 Ready to collaborate conflict-free? Get started with `pushwork init`!**
