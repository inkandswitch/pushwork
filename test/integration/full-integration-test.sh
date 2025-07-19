#!/bin/bash

# Comprehensive Integration Test for Pushwork
# Tests all major functionality of the sync tool

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test configuration
TEST_DIR="/tmp/pushwork-integration-test"
PUSHWORK_CMD="node $(pwd)/dist/cli.js"
CUSTOM_SYNC_SERVER="ws://localhost:3030"
CUSTOM_STORAGE_ID="1d89eba7-f7a4-4e8e-80f2-5f4e2406f507"

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
}

log_error() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((TESTS_FAILED++))
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_test() {
    echo -e "${YELLOW}[TEST]${NC} $1"
    ((TESTS_RUN++))
}

# Test wrapper function
run_test() {
    local test_name="$1"
    local test_cmd="$2"
    local expected_exit_code="${3:-0}"
    
    log_test "$test_name"
    
    if [ "$expected_exit_code" = "0" ]; then
        if eval "$test_cmd" > /dev/null 2>&1; then
            log_success "$test_name"
            return 0
        else
            log_error "$test_name (command failed)"
            return 1
        fi
    else
        if eval "$test_cmd" > /dev/null 2>&1; then
            log_error "$test_name (expected failure but succeeded)"
            return 1
        else
            log_success "$test_name (correctly failed)"
            return 0
        fi
    fi
}

# Cleanup function
cleanup() {
    log_info "Cleaning up test directory..."
    rm -rf "$TEST_DIR"
}

# Setup function
setup() {
    log_info "Setting up integration test environment..."
    
    # Build the project first
    log_info "Building pushwork..."
    npm run build
    
    # Clean up any existing test directory
    rm -rf "$TEST_DIR"
    mkdir -p "$TEST_DIR"
    cd "$TEST_DIR"
    
    log_info "Test directory: $TEST_DIR"
}

# Test functions

test_help_commands() {
    log_info "=== Testing Help Commands ==="
    
    run_test "pushwork --help" "$PUSHWORK_CMD --help"
    run_test "pushwork init --help" "$PUSHWORK_CMD init --help"
    run_test "pushwork clone --help" "$PUSHWORK_CMD clone --help"
    run_test "pushwork sync --help" "$PUSHWORK_CMD sync --help"
    run_test "pushwork status --help" "$PUSHWORK_CMD status --help"
    run_test "pushwork diff --help" "$PUSHWORK_CMD diff --help"
    run_test "pushwork commit --help" "$PUSHWORK_CMD commit --help"
}

test_init_functionality() {
    log_info "=== Testing Init Functionality ==="
    
    # Test init with default settings
    mkdir -p test-init-default
    cd test-init-default
    echo "Hello World" > test.txt
    
    run_test "init with default settings" "$PUSHWORK_CMD init ."
    run_test "check .pushwork directory exists" "[ -d .pushwork ]"
    run_test "check config file exists" "[ -f .pushwork/config.json ]"
    run_test "check snapshot file exists" "[ -f .pushwork/snapshot.json ]"
    
    cd ..
    
    # Test init with custom sync server
    mkdir -p test-init-custom
    cd test-init-custom
    echo "Custom Server Test" > custom.txt
    
    run_test "init with custom sync server" "$PUSHWORK_CMD init . --sync-server $CUSTOM_SYNC_SERVER --sync-server-storage-id $CUSTOM_STORAGE_ID"
    
    # Verify custom settings in config
    if [ -f .pushwork/config.json ]; then
        if grep -q "$CUSTOM_SYNC_SERVER" .pushwork/config.json; then
            log_success "custom sync server saved in config"
            ((TESTS_PASSED++))
        else
            log_error "custom sync server not found in config"
            ((TESTS_FAILED++))
        fi
        ((TESTS_RUN++))
        
        if grep -q "$CUSTOM_STORAGE_ID" .pushwork/config.json; then
            log_success "custom storage ID saved in config"
            ((TESTS_PASSED++))
        else
            log_error "custom storage ID not found in config"
            ((TESTS_FAILED++))
        fi
        ((TESTS_RUN++))
    fi
    
    cd ..
    
    # Test error cases
    run_test "init already initialized directory" "$PUSHWORK_CMD init test-init-default" 1
    run_test "init with only sync-server (should fail)" "$PUSHWORK_CMD init test-fail --sync-server $CUSTOM_SYNC_SERVER" 1
    run_test "init with only storage-id (should fail)" "$PUSHWORK_CMD init test-fail --sync-server-storage-id $CUSTOM_STORAGE_ID" 1
}

test_status_functionality() {
    log_info "=== Testing Status Functionality ==="
    
    cd test-init-default
    run_test "status in initialized directory" "$PUSHWORK_CMD status"
    cd ..
    
    run_test "status in non-initialized directory" "$PUSHWORK_CMD status" 1
}

test_commit_functionality() {
    log_info "=== Testing Commit Functionality ==="
    
    cd test-init-default
    
    # Add some files
    echo "New content" > new-file.txt
    echo "Modified content" >> test.txt
    
    run_test "commit with changes" "$PUSHWORK_CMD commit ."
    run_test "commit dry-run" "$PUSHWORK_CMD commit . --dry-run"
    
    cd ..
}

test_sync_functionality() {
    log_info "=== Testing Sync Functionality ==="
    
    cd test-init-default
    
    run_test "sync in initialized directory" "$PUSHWORK_CMD sync"
    run_test "sync dry-run" "$PUSHWORK_CMD sync --dry-run"
    run_test "sync local-only" "$PUSHWORK_CMD sync --local-only"
    
    cd ..
}

test_diff_functionality() {
    log_info "=== Testing Diff Functionality ==="
    
    cd test-init-default
    
    # Make some changes
    echo "Diff test content" > diff-test.txt
    
    run_test "diff command" "$PUSHWORK_CMD diff"
    run_test "diff name-only" "$PUSHWORK_CMD diff --name-only"
    run_test "diff local-only" "$PUSHWORK_CMD diff --local-only"
    
    cd ..
}

test_clone_functionality() {
    log_info "=== Testing Clone Functionality ==="
    
    # First, we need a valid URL to clone from the initialized directory
    cd test-init-default
    
    if [ -f .pushwork/snapshot.json ] && command -v jq &> /dev/null; then
        ROOT_URL=$(jq -r '.rootDirectoryUrl' .pushwork/snapshot.json)
        
        if [ "$ROOT_URL" != "null" ] && [ -n "$ROOT_URL" ]; then
            cd ..
            
            # Test clone with default settings
            run_test "clone with default settings" "$PUSHWORK_CMD clone $ROOT_URL test-clone-default"
            
            if [ -d test-clone-default ]; then
                run_test "cloned directory has .pushwork" "[ -d test-clone-default/.pushwork ]"
                run_test "cloned directory has files" "[ -f test-clone-default/test.txt ]"
            fi
            
            # Test clone with custom sync server
            run_test "clone with custom sync server" "$PUSHWORK_CMD clone $ROOT_URL test-clone-custom --sync-server $CUSTOM_SYNC_SERVER --sync-server-storage-id $CUSTOM_STORAGE_ID"
            
            # Test clone error cases
            mkdir -p existing-dir
            echo "existing" > existing-dir/file.txt
            run_test "clone to non-empty directory (should fail)" "$PUSHWORK_CMD clone $ROOT_URL existing-dir" 1
            run_test "clone with force to non-empty directory" "$PUSHWORK_CMD clone $ROOT_URL existing-dir --force"
            
            run_test "clone with only sync-server (should fail)" "$PUSHWORK_CMD clone $ROOT_URL test-fail --sync-server $CUSTOM_SYNC_SERVER" 1
            run_test "clone with only storage-id (should fail)" "$PUSHWORK_CMD clone $ROOT_URL test-fail --sync-server-storage-id $CUSTOM_STORAGE_ID" 1
        else
            log_warning "No valid root URL found in snapshot, skipping clone tests"
        fi
    else
        log_warning "jq not available or snapshot missing, skipping clone tests"
    fi
    
    cd ..
}

test_bidirectional_sync() {
    log_info "=== Testing Bidirectional Sync ==="
    
    # This test requires both directories to be properly initialized
    if [ -d test-init-default ] && [ -d test-clone-default ]; then
        # Add content in original
        cd test-init-default
        echo "From original" > sync-test.txt
        $PUSHWORK_CMD commit . > /dev/null 2>&1 || true
        cd ..
        
        # Add different content in clone
        cd test-clone-default
        echo "From clone" > sync-test-clone.txt
        $PUSHWORK_CMD commit . > /dev/null 2>&1 || true
        cd ..
        
        # Try to sync both
        cd test-init-default
        run_test "sync from original" "$PUSHWORK_CMD sync --local-only"
        cd ..
        
        cd test-clone-default
        run_test "sync from clone" "$PUSHWORK_CMD sync --local-only"
        cd ..
    else
        log_warning "Clone directories not available, skipping bidirectional sync test"
    fi
}

test_file_operations() {
    log_info "=== Testing File Operations ==="
    
    mkdir -p test-file-ops
    cd test-file-ops
    
    # Initialize
    $PUSHWORK_CMD init . > /dev/null 2>&1
    
    # Test various file operations
    echo "Text file" > text.txt
    echo -e "\x89PNG\r\n\x1a\n" > binary.png  # Fake PNG header
    mkdir -p subdir
    echo "Subdirectory file" > subdir/nested.txt
    
    run_test "commit various file types" "$PUSHWORK_CMD commit ."
    run_test "status after file operations" "$PUSHWORK_CMD status"
    
    # Modify files
    echo "Modified text" >> text.txt
    rm binary.png
    echo "New file" > new.txt
    
    run_test "diff after modifications" "$PUSHWORK_CMD diff --name-only"
    run_test "commit modifications" "$PUSHWORK_CMD commit ."
    
    cd ..
}

# Main test execution
main() {
    echo "======================================"
    echo "Pushwork Integration Test Suite"
    echo "======================================"
    
    # Trap cleanup on exit
    trap cleanup EXIT
    
    # Setup
    setup
    
    # Run all tests
    test_help_commands
    test_init_functionality
    test_status_functionality
    test_commit_functionality
    test_sync_functionality
    test_diff_functionality
    test_clone_functionality
    test_bidirectional_sync
    test_file_operations
    
    # Summary
    echo ""
    echo "======================================"
    echo "Test Results Summary"
    echo "======================================"
    echo "Tests Run:    $TESTS_RUN"
    echo "Tests Passed: $TESTS_PASSED"
    echo "Tests Failed: $TESTS_FAILED"
    
    if [ $TESTS_FAILED -eq 0 ]; then
        log_success "All tests passed!"
        exit 0
    else
        log_error "Some tests failed!"
        exit 1
    fi
}

# Check if jq is available (optional dependency)
if ! command -v jq &> /dev/null; then
    log_warning "jq is not installed - some tests may be skipped"
fi

# Run the tests
main "$@" 