#!/bin/bash
set -e

# Get absolute path to pushwork CLI
PUSHWORK_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PUSHWORK_CLI="$PUSHWORK_ROOT/dist/cli.js"

echo "=== Creating test repos ==="
TESTDIR=$(mktemp -d)
REPO_A="$TESTDIR/repo-a"
REPO_B="$TESTDIR/repo-b"
mkdir -p "$REPO_A" "$REPO_B"

echo "=== Initializing repo A with a file ==="
echo "initial" > "$REPO_A/initial.txt"
cd "$REPO_A"
node "$PUSHWORK_CLI" init .

echo ""
echo "=== Cloning to repo B ==="
ROOT_URL=$(node "$PUSHWORK_CLI" url)
echo "Root URL: $ROOT_URL"
cd "$TESTDIR"
node "$PUSHWORK_CLI" clone "$ROOT_URL" "$REPO_B"

echo ""
echo "=== On B: Create file in 2-level nested subdirectory ==="
mkdir -p "$REPO_B/rlpjug/ewsv"
echo "" > "$REPO_B/rlpjug/ewsv/sneked.txt"

echo ""
echo "=== Sync round 1: A (no changes) ==="
cd "$REPO_A"
node "$PUSHWORK_CLI" sync

echo ""
echo "=== Sync round 1: B (push new nested file) ==="
cd "$REPO_B"
node "$PUSHWORK_CLI" sync

echo ""
echo "=== Sync round 2: A (pull B's changes) ==="
cd "$REPO_A"
node "$PUSHWORK_CLI" sync

echo ""
echo "=== Sync round 2: B (confirm) ==="
cd "$REPO_B"
node "$PUSHWORK_CLI" sync

echo ""
echo "=== Verification ==="
echo "Files in A:"
find "$REPO_A" -type f \( -name "*.txt" -o -name "*.md" \) | grep -v "\.pushwork" | sed "s|$REPO_A/||" | sort

echo ""
echo "Files in B:"
find "$REPO_B" -type f \( -name "*.txt" -o -name "*.md" \) | grep -v "\.pushwork" | sed "s|$REPO_B/||" | sort

echo ""
if [ -f "$REPO_A/rlpjug/ewsv/sneked.txt" ]; then
  echo "✅ SUCCESS: Nested file synced to A"
else
  echo "❌ FAILURE: Nested file did NOT sync to A"
  echo ""
  echo "Let's check if directories exist:"
  echo "A has rlpjug dir: $([ -d "$REPO_A/rlpjug" ] && echo YES || echo NO)"
  echo "A has rlpjug/ewsv dir: $([ -d "$REPO_A/rlpjug/ewsv" ] && echo YES || echo NO)"
fi

echo ""
echo "Test directory: $TESTDIR"

