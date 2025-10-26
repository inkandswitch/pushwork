#!/bin/bash
set -x  # Print commands as they execute
set -e  # Exit on error

# Get absolute path to pushwork CLI
PUSHWORK_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PUSHWORK_CLI="$PUSHWORK_ROOT/dist/cli.js"

echo "Pushwork CLI: $PUSHWORK_CLI"

# Create temp directory
TESTDIR=$(mktemp -d)
echo "Test directory: $TESTDIR"

REPO_A="$TESTDIR/repo-a"
REPO_B="$TESTDIR/repo-b"

mkdir -p "$REPO_A"
mkdir -p "$REPO_B"

# Step 1: Create initial file in repo A
echo "=== Step 1: Creating initial file in repo A ==="
echo "initial content" > "$REPO_A/test.txt"
cat "$REPO_A/test.txt"

# Step 2: Initialize repo A
echo "=== Step 2: Initializing repo A ==="
cd "$REPO_A"
node "$PUSHWORK_CLI" init .
sleep 1

# Step 3: Get root URL
echo "=== Step 3: Getting root URL from repo A ==="
ROOT_URL=$(node "$PUSHWORK_CLI" url)
echo "Root URL: $ROOT_URL"

# Step 4: Clone to repo B
echo "=== Step 4: Cloning to repo B ==="
cd "$TESTDIR"
node "$PUSHWORK_CLI" clone "$ROOT_URL" "$REPO_B"
sleep 1

# Step 5: Verify initial state
echo "=== Step 5: Verifying initial state ==="
echo "Content in A:"
cat "$REPO_A/test.txt"
echo "Content in B:"
cat "$REPO_B/test.txt"

# Step 6: Modify file in repo A
echo "=== Step 6: Modifying file in repo A ==="
echo "modified content" > "$REPO_A/test.txt"
echo "New content in A:"
cat "$REPO_A/test.txt"

# Step 7: Sync repo A (THIS IS WHERE IT MIGHT HANG)
echo "=== Step 7: Syncing repo A ==="
cd "$REPO_A"
echo "Running sync in A at $(date)..."
timeout 10 node "$PUSHWORK_CLI" sync || echo "SYNC A TIMED OUT!"
echo "Sync A completed at $(date)"
sleep 1

# Step 8: Sync repo B
echo "=== Step 8: Syncing repo B ==="
cd "$REPO_B"
echo "Running sync in B at $(date)..."
timeout 10 node "$PUSHWORK_CLI" sync || echo "SYNC B TIMED OUT!"
echo "Sync B completed at $(date)"
sleep 1

# Step 9: Verify final state
echo "=== Step 9: Verifying final state ==="
echo "Final content in A:"
cat "$REPO_A/test.txt"
echo "Final content in B:"
cat "$REPO_B/test.txt"

# Cleanup
echo "=== Cleanup ==="
echo "Test directory: $TESTDIR"
echo "To inspect manually: cd $TESTDIR"
# rm -rf "$TESTDIR"

