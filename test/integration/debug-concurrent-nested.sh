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
echo "=== On A: Create file in nested directory dirA/subA ==="
mkdir -p "$REPO_A/dirA/subA"
echo "from A" > "$REPO_A/dirA/subA/fileA.txt"

echo ""
echo "=== On B: Create file in different nested directory dirB/subB ==="
mkdir -p "$REPO_B/dirB/subB"
echo "from B" > "$REPO_B/dirB/subB/fileB.txt"

echo ""
echo "=== Sync round 1: A (push A's nested file) ==="
cd "$REPO_A"
node "$PUSHWORK_CLI" sync

echo ""
echo "=== Sync round 1: B (push B's nested file, pull A's) ==="
cd "$REPO_B"
node "$PUSHWORK_CLI" sync

echo ""
echo "=== Sync round 2: A (pull B's nested file) ==="
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
echo "Checking convergence:"
A_HAS_A=$([ -f "$REPO_A/dirA/subA/fileA.txt" ] && echo YES || echo NO)
A_HAS_B=$([ -f "$REPO_A/dirB/subB/fileB.txt" ] && echo YES || echo NO)
B_HAS_A=$([ -f "$REPO_B/dirA/subA/fileA.txt" ] && echo YES || echo NO)
B_HAS_B=$([ -f "$REPO_B/dirB/subB/fileB.txt" ] && echo YES || echo NO)

echo "  A has its own file (dirA/subA/fileA.txt): $A_HAS_A"
echo "  A has B's file (dirB/subB/fileB.txt): $A_HAS_B"
echo "  B has A's file (dirA/subA/fileA.txt): $B_HAS_A"
echo "  B has its own file (dirB/subB/fileB.txt): $B_HAS_B"

if [ "$A_HAS_A" = "YES" ] && [ "$A_HAS_B" = "YES" ] && [ "$B_HAS_A" = "YES" ] && [ "$B_HAS_B" = "YES" ]; then
  echo ""
  echo "✅ SUCCESS: Both nested files synced correctly!"
else
  echo ""
  echo "❌ FAILURE: Not all files synced"
fi

echo ""
echo "Test directory: $TESTDIR"

