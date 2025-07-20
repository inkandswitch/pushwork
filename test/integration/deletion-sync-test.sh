#!/bin/bash

# Deletion Sync Test: Bob deletes, Alice receives deletion
# Tests end-to-end deletion propagation through sync

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test configuration
TEST_DIR="/tmp/pushwork-deletion-test-$$"
BOB_DIR="$TEST_DIR/bob"
ALICE_DIR="$TEST_DIR/alice"
PUSHWORK_CMD="npm run start --silent --"
SYNC_SERVER="ws://localhost:3030"
STORAGE_ID="deletion-test-$(date +%s)"
TEST_FILE="shared-document.ts"
TEST_CONTENT="interface SharedInterface { id: number; name: string; }"

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1"
}

log_test() {
    echo -e "${YELLOW}[TEST]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# Cleanup function
cleanup() {
    if [ -d "$TEST_DIR" ]; then
        log_info "Cleaning up test directories..."
        rm -rf "$TEST_DIR"
    fi
}

# Error handler
handle_error() {
    log_error "Test failed at line $1"
    log_info "Bob's directory contents:"
    if [ -d "$BOB_DIR" ]; then
        ls -la "$BOB_DIR" || true
    fi
    log_info "Alice's directory contents:"
    if [ -d "$ALICE_DIR" ]; then
        ls -la "$ALICE_DIR" || true
    fi
    cleanup
    exit 1
}

# Set up error handling
trap 'handle_error $LINENO' ERR
trap cleanup EXIT

# Helper function to run pushwork commands
run_pushwork() {
    local dir="$1"
    local cmd="$2"
    local user="$3"
    
    log_test "${user}: Running 'pushwork $cmd'"
    cd "$dir"
    
    # Capture both stdout and stderr
    if output=$(eval "$PUSHWORK_CMD $cmd" 2>&1); then
        if [ -n "$output" ]; then
            echo "  Output: $output"
        fi
        return 0
    else
        log_error "${user}: Command failed: $output"
        return 1
    fi
}

# Helper function to check if file exists
check_file_exists() {
    local dir="$1"
    local file="$2"
    local user="$3"
    local should_exist="$4"
    
    if [ -f "$dir/$file" ]; then
        if [ "$should_exist" = "true" ]; then
            log_success "${user}: File '$file' exists (expected)"
            return 0
        else
            log_error "${user}: File '$file' exists (should be deleted)"
            return 1
        fi
    else
        if [ "$should_exist" = "false" ]; then
            log_success "${user}: File '$file' is deleted (expected)"
            return 0
        else
            log_error "${user}: File '$file' is missing (should exist)"
            return 1
        fi
    fi
}

# Helper function to show directory contents
show_directory_contents() {
    local dir="$1"
    local user="$2"
    
    log_info "${user}'s directory contents:"
    cd "$dir"
    if [ "$(ls -A .)" ]; then
        ls -la . | grep -v "^total" | tail -n +2 | while read line; do
            echo "  $line"
        done
    else
        echo "  (empty directory)"
    fi
}

# Main test function
main() {
    echo "======================================"
    echo "Pushwork Deletion Sync Test"
    echo "======================================"
    echo "Testing: Bob deletes file → sync → Alice loses file"
    echo ""

    # Setup
    log_info "Setting up test environment..."
    mkdir -p "$BOB_DIR" "$ALICE_DIR"
    
    log_info "Test configuration:"
    echo "  Bob's directory:   $BOB_DIR"
    echo "  Alice's directory: $ALICE_DIR"
    echo "  Sync server:       $SYNC_SERVER"
    echo "  Storage ID:        $STORAGE_ID"
    echo "  Test file:         $TEST_FILE"
    echo ""

    # Phase 1: Initialize both repositories
    log_info "=== Phase 1: Initialize Repositories ==="
    
    log_test "Initializing Bob's repository..."
    run_pushwork "$BOB_DIR" "init . --sync-server '$SYNC_SERVER' --storage-id '$STORAGE_ID'" "Bob"
    
    log_test "Initializing Alice's repository..."
    run_pushwork "$ALICE_DIR" "clone --sync-server '$SYNC_SERVER' --storage-id '$STORAGE_ID' ." "Alice"
    
    # Phase 2: Create initial shared file
    log_info "=== Phase 2: Create Shared File ==="
    
    log_test "Bob creates the shared file..."
    echo "$TEST_CONTENT" > "$BOB_DIR/$TEST_FILE"
    check_file_exists "$BOB_DIR" "$TEST_FILE" "Bob" "true"
    
    log_test "Bob commits the file..."
    run_pushwork "$BOB_DIR" "commit ." "Bob"
    
    log_test "Bob syncs to share the file..."
    run_pushwork "$BOB_DIR" "sync" "Bob"
    
    log_test "Alice syncs to receive the file..."
    run_pushwork "$ALICE_DIR" "sync" "Alice"
    
    # Verify both have the file
    check_file_exists "$BOB_DIR" "$TEST_FILE" "Bob" "true"
    check_file_exists "$ALICE_DIR" "$TEST_FILE" "Alice" "true"
    
    log_success "Phase 2: Both users have the shared file"
    echo ""

    # Phase 3: Bob deletes the file
    log_info "=== Phase 3: Bob Deletes File ==="
    
    show_directory_contents "$BOB_DIR" "Bob (before deletion)"
    
    log_test "Bob deletes the shared file..."
    rm "$BOB_DIR/$TEST_FILE"
    check_file_exists "$BOB_DIR" "$TEST_FILE" "Bob" "false"
    
    show_directory_contents "$BOB_DIR" "Bob (after deletion)"
    
    log_test "Bob commits the deletion..."
    run_pushwork "$BOB_DIR" "commit ." "Bob"
    
    # Verify file is still gone on Bob's side
    check_file_exists "$BOB_DIR" "$TEST_FILE" "Bob" "false"
    
    log_success "Phase 3: Bob successfully deleted and committed"
    echo ""

    # Phase 4: Bob syncs the deletion
    log_info "=== Phase 4: Bob Syncs Deletion ==="
    
    log_test "Bob syncs to propagate the deletion..."
    run_pushwork "$BOB_DIR" "sync" "Bob"
    
    # Verify file is still gone on Bob's side after sync
    check_file_exists "$BOB_DIR" "$TEST_FILE" "Bob" "false"
    
    log_test "Bob checks status after sync..."
    run_pushwork "$BOB_DIR" "status" "Bob"
    
    log_success "Phase 4: Bob's deletion synced successfully"
    echo ""

    # Phase 5: Alice syncs to receive the deletion
    log_info "=== Phase 5: Alice Syncs to Receive Deletion ==="
    
    show_directory_contents "$ALICE_DIR" "Alice (before sync)"
    
    # Alice should still have the file before syncing
    check_file_exists "$ALICE_DIR" "$TEST_FILE" "Alice" "true"
    
    log_test "Alice syncs to receive Bob's deletion..."
    run_pushwork "$ALICE_DIR" "sync" "Alice"
    
    show_directory_contents "$ALICE_DIR" "Alice (after sync)"
    
    # Critical test: Alice should now have the file deleted
    check_file_exists "$ALICE_DIR" "$TEST_FILE" "Alice" "false"
    
    log_test "Alice checks status after sync..."
    run_pushwork "$ALICE_DIR" "status" "Alice"
    
    log_success "Phase 5: Alice received the deletion successfully"
    echo ""

    # Phase 6: Verification
    log_info "=== Phase 6: Final Verification ==="
    
    log_test "Final verification of both repositories..."
    
    # Both should have no trace of the deleted file
    check_file_exists "$BOB_DIR" "$TEST_FILE" "Bob" "false"
    check_file_exists "$ALICE_DIR" "$TEST_FILE" "Alice" "false"
    
    # Check for any unexpected files
    show_directory_contents "$BOB_DIR" "Bob (final)"
    show_directory_contents "$ALICE_DIR" "Alice (final)"
    
    # Run final status checks
    log_test "Bob's final status:"
    run_pushwork "$BOB_DIR" "status" "Bob"
    
    log_test "Alice's final status:"
    run_pushwork "$ALICE_DIR" "status" "Alice"
    
    log_success "Phase 6: All verifications passed"
    echo ""

    # Success!
    echo "======================================"
    echo "🎉 DELETION SYNC TEST PASSED! 🎉"
    echo "======================================"
    echo "✅ Bob deleted file successfully"
    echo "✅ Bob's sync propagated deletion"
    echo "✅ Alice received deletion correctly"
    echo "✅ Both repositories in sync"
    echo ""
    echo "This test validates that file deletions"
    echo "propagate correctly through the sync engine!"
}

# Check if we're in the right directory
if [ ! -f "package.json" ] || ! grep -q "pushwork" package.json; then
    log_error "This script must be run from the pushwork project root directory"
    exit 1
fi

# Check if dependencies are available
if ! command -v npm &> /dev/null; then
    log_error "npm is not installed or not in PATH"
    exit 1
fi

# Run the test
main

echo ""
echo "Test completed successfully! 🚀" 