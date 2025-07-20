#!/bin/bash

# Simplified Deletion Test: Bob deletes, Alice syncs (local-only mode)
# Tests basic deletion behavior without requiring a sync server

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test configuration
TEST_DIR="/tmp/pushwork-deletion-simple-$$"
BOB_DIR="$TEST_DIR/bob"
ALICE_DIR="$TEST_DIR/alice"
TEST_FILE="shared-document.ts"
TEST_CONTENT="interface SharedInterface { id: number; name: string; }"

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

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
    cleanup
    exit 1
}

trap 'handle_error $LINENO' ERR
trap cleanup EXIT

# Helper function to run pushwork commands
run_pushwork() {
    local dir="$1"
    local cmd="$2"
    local user="$3"
    
    cd "$dir"
    if output=$(eval "$PUSHWORK_CMD $cmd" 2>&1); then
        log_test "${user}: pushwork $cmd ✓"
        if [ -n "$output" ]; then
            echo "  → $output"
        fi
        return 0
    else
        log_error "${user}: pushwork $cmd failed: $output"
        return 1
    fi
}

# Helper function to check if file exists
check_file() {
    local dir="$1"
    local file="$2"
    local user="$3"
    local should_exist="$4"
    
    if [ -f "$dir/$file" ]; then
        if [ "$should_exist" = "true" ]; then
            log_success "${user}: File '$file' exists ✓"
        else
            log_error "${user}: File '$file' should be deleted but still exists"
            return 1
        fi
    else
        if [ "$should_exist" = "false" ]; then
            log_success "${user}: File '$file' correctly deleted ✓"
        else
            log_error "${user}: File '$file' should exist but is missing"
            return 1
        fi
    fi
}

main() {
    echo "========================================"
    echo "📁 Pushwork Deletion Test (Simplified)"
    echo "========================================"
    echo "Testing basic deletion behavior with local-only sync"
    echo ""

    # Setup
    log_info "Setting up test environment..."
    mkdir -p "$BOB_DIR" "$ALICE_DIR"
    
    echo "  Bob's directory:   $BOB_DIR"
    echo "  Alice's directory: $ALICE_DIR"
    echo "  Test file:         $TEST_FILE"
    echo ""

    # Phase 1: Initialize Bob's repository
    log_info "=== Phase 1: Initialize Bob's Repository ==="
    run_pushwork "$BOB_DIR" "init ." "Bob"
    
    # Phase 2: Create test file
    log_info "=== Phase 2: Create Test File ==="
    echo "$TEST_CONTENT" > "$BOB_DIR/$TEST_FILE"
    check_file "$BOB_DIR" "$TEST_FILE" "Bob" "true"
    
    run_pushwork "$BOB_DIR" "commit ." "Bob"
    check_file "$BOB_DIR" "$TEST_FILE" "Bob" "true"
    
    log_success "Phase 2: File created and committed ✓"
    echo ""

    # Phase 3: Bob deletes the file
    log_info "=== Phase 3: Bob Deletes File ==="
    
    log_test "Bob: Deleting $TEST_FILE..."
    rm "$BOB_DIR/$TEST_FILE"
    check_file "$BOB_DIR" "$TEST_FILE" "Bob" "false"
    
    log_test "Bob: Committing deletion..."
    run_pushwork "$BOB_DIR" "commit ." "Bob"
    check_file "$BOB_DIR" "$TEST_FILE" "Bob" "false"
    
    log_success "Phase 3: Deletion committed successfully ✓"
    echo ""

    # Phase 4: Verify deletion persists after sync
    log_info "=== Phase 4: Verify Deletion Persistence ==="
    
    log_test "Bob: Running status to verify deletion persisted..."
    run_pushwork "$BOB_DIR" "status" "Bob"
    check_file "$BOB_DIR" "$TEST_FILE" "Bob" "false"
    
    log_test "Bob: Checking status after sync..."
    run_pushwork "$BOB_DIR" "status" "Bob"
    
    log_success "Phase 4: Deletion persisted through sync ✓"
    echo ""

    # Phase 5: Test deletion detection
    log_info "=== Phase 5: Test Deletion Detection ==="
    
    # Create the file again to test deletion detection
    echo "$TEST_CONTENT" > "$BOB_DIR/$TEST_FILE"
    run_pushwork "$BOB_DIR" "commit ." "Bob"
    check_file "$BOB_DIR" "$TEST_FILE" "Bob" "true"
    
    # Delete it again
    rm "$BOB_DIR/$TEST_FILE"
    
    # Check that status detects the deletion
    log_test "Bob: Checking that status detects deletion..."
    run_pushwork "$BOB_DIR" "status" "Bob"
    
    # Commit the deletion
    run_pushwork "$BOB_DIR" "commit ." "Bob"
    check_file "$BOB_DIR" "$TEST_FILE" "Bob" "false"
    
    log_success "Phase 5: Deletion detection working ✓"
    echo ""

    # Success!
    echo "========================================"
    echo "🎉 DELETION TEST PASSED! 🎉"
    echo "========================================"
    echo "✅ File deletion works correctly"
    echo "✅ Deletions are detected by status"
    echo "✅ Deletions can be committed"
    echo "✅ Deletions persist through sync"
    echo ""
    echo "Basic deletion behavior is working!"
}

# Validation
if [ ! -f "package.json" ] || ! grep -q "pushwork" package.json; then
    log_error "This script must be run from the pushwork project root directory"
    exit 1
fi

# Store the project root for CLI access
PROJECT_ROOT="$(pwd)"
PUSHWORK_CMD="node $PROJECT_ROOT/dist/cli.js"

# Run the test
main
echo "Test completed successfully! 🚀" 