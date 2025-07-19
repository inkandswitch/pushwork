#!/bin/bash

# Focused Clone Functionality Test for Pushwork
# Tests the clone command with various sync server configurations

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test configuration
TEST_DIR="/tmp/pushwork-clone-test"
PUSHWORK_CMD="node $(pwd)/dist/cli.js"
CUSTOM_SYNC_SERVER="ws://localhost:3030"
CUSTOM_STORAGE_ID="1d89eba7-f7a4-4e8e-80f2-5f4e2406f507"

# Helper functions
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

# Cleanup function
cleanup() {
    log_info "Cleaning up test directory..."
    rm -rf "$TEST_DIR"
}

# Setup function
setup() {
    log_info "Setting up clone test environment..."
    
    # Build the project
    log_info "Building pushwork..."
    npm run build
    
    # Clean up and create test directory
    rm -rf "$TEST_DIR"
    mkdir -p "$TEST_DIR"
    cd "$TEST_DIR"
    
    log_info "Test directory: $TEST_DIR"
}

# Create a test repository to clone from
create_test_repo() {
    log_info "Creating test repository..."
    
    mkdir source-repo
    cd source-repo
    
    # Add some test files
    echo "Hello from source repo" > hello.txt
    echo "# Test Repository" > README.md
    mkdir -p docs
    echo "Documentation content" > docs/guide.md
    
    # Initialize with default settings
    $PUSHWORK_CMD init .
    
    cd ..
    
    log_success "Test repository created"
}

# Test clone functionality
test_clone_functionality() {
    log_info "=== Testing Clone Functionality ==="
    
    cd source-repo
    
    # Get the root URL from the snapshot
    if [ -f .pushwork/snapshot.json ] && command -v jq &> /dev/null; then
        ROOT_URL=$(jq -r '.rootDirectoryUrl' .pushwork/snapshot.json)
        
        if [ "$ROOT_URL" != "null" ] && [ -n "$ROOT_URL" ]; then
            cd ..
            
            log_test "Clone with default settings"
            if $PUSHWORK_CMD clone "$ROOT_URL" clone-default; then
                log_success "Clone with default settings"
                
                # Verify cloned content
                if [ -f clone-default/hello.txt ] && [ -f clone-default/README.md ]; then
                    log_success "Cloned files are present"
                else
                    log_error "Cloned files are missing"
                fi
                
                # Check configuration
                if [ -f clone-default/.pushwork/config.json ]; then
                    if grep -q "wss://sync3.automerge.org" clone-default/.pushwork/config.json; then
                        log_success "Default sync server in config"
                    else
                        log_error "Default sync server not found in config"
                    fi
                fi
            else
                log_error "Clone with default settings failed"
            fi
            
            log_test "Clone with custom sync server"
            if $PUSHWORK_CMD clone "$ROOT_URL" clone-custom --sync-server "$CUSTOM_SYNC_SERVER" --sync-server-storage-id "$CUSTOM_STORAGE_ID"; then
                log_success "Clone with custom sync server"
                
                # Verify custom configuration
                if [ -f clone-custom/.pushwork/config.json ]; then
                    if grep -q "$CUSTOM_SYNC_SERVER" clone-custom/.pushwork/config.json; then
                        log_success "Custom sync server in config"
                    else
                        log_error "Custom sync server not found in config"
                    fi
                    
                    if grep -q "$CUSTOM_STORAGE_ID" clone-custom/.pushwork/config.json; then
                        log_success "Custom storage ID in config"
                    else
                        log_error "Custom storage ID not found in config"
                    fi
                fi
            else
                log_error "Clone with custom sync server failed"
            fi
            
            # Test error cases
            log_test "Clone with incomplete sync server options"
            
            # Only sync server (should fail)
            if $PUSHWORK_CMD clone "$ROOT_URL" clone-fail1 --sync-server "$CUSTOM_SYNC_SERVER" 2>/dev/null; then
                log_error "Clone with only sync-server should have failed"
            else
                log_success "Clone correctly failed with only sync-server"
            fi
            
            # Only storage ID (should fail)
            if $PUSHWORK_CMD clone "$ROOT_URL" clone-fail2 --sync-server-storage-id "$CUSTOM_STORAGE_ID" 2>/dev/null; then
                log_error "Clone with only storage-id should have failed"
            else
                log_success "Clone correctly failed with only storage-id"
            fi
            
            # Test force overwrite
            mkdir -p existing-dir
            echo "existing content" > existing-dir/existing.txt
            
            log_test "Clone to non-empty directory without force"
            if $PUSHWORK_CMD clone "$ROOT_URL" existing-dir 2>/dev/null; then
                log_error "Clone to non-empty directory should have failed"
            else
                log_success "Clone correctly failed for non-empty directory"
            fi
            
            log_test "Clone to non-empty directory with force"
            if $PUSHWORK_CMD clone "$ROOT_URL" existing-dir --force; then
                log_success "Clone with force succeeded"
                
                # Check that original files were replaced
                if [ -f existing-dir/hello.txt ]; then
                    log_success "Force clone replaced existing content"
                else
                    log_error "Force clone did not replace content properly"
                fi
            else
                log_error "Clone with force failed"
            fi
            
        else
            log_error "No valid root URL found in snapshot"
        fi
    else
        log_error "jq not available or snapshot missing"
    fi
    
    cd ..
}

# Test status commands in cloned directories
test_cloned_directory_status() {
    log_info "=== Testing Status in Cloned Directories ==="
    
    if [ -d clone-default ]; then
        cd clone-default
        
        log_test "Status in cloned directory"
        if $PUSHWORK_CMD status; then
            log_success "Status command works in cloned directory"
        else
            log_error "Status command failed in cloned directory"
        fi
        
        # Make some changes and test
        echo "Modified in clone" >> hello.txt
        echo "New file in clone" > new-file.txt
        
        log_test "Status after changes in clone"
        if $PUSHWORK_CMD status; then
            log_success "Status shows changes in clone"
        else
            log_error "Status failed to show changes"
        fi
        
        log_test "Diff in cloned directory"
        if $PUSHWORK_CMD diff --name-only; then
            log_success "Diff command works in cloned directory"
        else
            log_error "Diff command failed in cloned directory"
        fi
        
        cd ..
    else
        log_error "Clone directory not available for status testing"
    fi
}

# Compare configurations between source and cloned repos
compare_configurations() {
    log_info "=== Comparing Configurations ==="
    
    if [ -f source-repo/.pushwork/config.json ] && [ -f clone-default/.pushwork/config.json ]; then
        log_test "Comparing default clone configuration"
        
        SOURCE_SYNC_SERVER=$(jq -r '.sync_server' source-repo/.pushwork/config.json 2>/dev/null || echo "")
        CLONE_SYNC_SERVER=$(jq -r '.sync_server' clone-default/.pushwork/config.json 2>/dev/null || echo "")
        
        if [ "$SOURCE_SYNC_SERVER" = "$CLONE_SYNC_SERVER" ]; then
            log_success "Sync server matches between source and clone"
        else
            log_error "Sync server differs: source=[$SOURCE_SYNC_SERVER] clone=[$CLONE_SYNC_SERVER]"
        fi
    fi
    
    if [ -f clone-custom/.pushwork/config.json ]; then
        log_test "Verifying custom clone configuration"
        
        CUSTOM_CLONE_SERVER=$(jq -r '.sync_server' clone-custom/.pushwork/config.json 2>/dev/null || echo "")
        CUSTOM_CLONE_STORAGE=$(jq -r '.sync_server_storage_id' clone-custom/.pushwork/config.json 2>/dev/null || echo "")
        
        if [ "$CUSTOM_CLONE_SERVER" = "$CUSTOM_SYNC_SERVER" ]; then
            log_success "Custom sync server correctly set in clone"
        else
            log_error "Custom sync server incorrect: expected=[$CUSTOM_SYNC_SERVER] actual=[$CUSTOM_CLONE_SERVER]"
        fi
        
        if [ "$CUSTOM_CLONE_STORAGE" = "$CUSTOM_STORAGE_ID" ]; then
            log_success "Custom storage ID correctly set in clone"
        else
            log_error "Custom storage ID incorrect: expected=[$CUSTOM_STORAGE_ID] actual=[$CUSTOM_CLONE_STORAGE]"
        fi
    fi
}

# Main test execution
main() {
    echo "======================================"
    echo "Pushwork Clone Functionality Test"
    echo "======================================"
    
    # Trap cleanup on exit
    trap cleanup EXIT
    
    # Setup
    setup
    
    # Create test repository
    create_test_repo
    
    # Run clone tests
    test_clone_functionality
    test_cloned_directory_status
    compare_configurations
    
    echo ""
    echo "======================================"
    echo "Clone Test Complete"
    echo "======================================"
    
    log_success "All clone functionality tests completed!"
}

# Check dependencies
if ! command -v jq &> /dev/null; then
    log_error "jq is required for this test script"
    echo "Please install jq: brew install jq (macOS) or apt-get install jq (Ubuntu)"
    exit 1
fi

# Run the tests
main "$@" 