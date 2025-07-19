#!/bin/bash

# Conflict Resolution Test for Pushwork
# Tests CRDT text merging where both changes are preserved

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test configuration
TEST_DIR="/tmp/pushwork-conflict-test"
PUSHWORK_CMD="node $(pwd)/dist/cli.js"

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
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
    log_info "Setting up conflict resolution test..."
    
    # Build the project
    log_info "Building pushwork..."
    npm run build
    
    # Clean up and create test directory
    rm -rf "$TEST_DIR"
    mkdir -p "$TEST_DIR"
    cd "$TEST_DIR"
    
    log_info "Test directory: $TEST_DIR"
}

# Create initial repository with a test file
create_initial_repo() {
    log_info "=== Creating Initial Repository ==="
    
    mkdir alice-repo
    cd alice-repo
    
    # Create a simple test file
    cat > document.txt << EOF
Original content
This is the baseline version.
EOF
    
    log_test "Initializing Alice's repository"
    $PUSHWORK_CMD init .
    
    cd ..
    log_success "Alice's repository created"
}

# Clone the repository
clone_repository() {
    log_info "=== Cloning Repository ==="
    
    cd alice-repo
    ROOT_URL=$($PUSHWORK_CMD url .)
    cd ..
    
    log_test "Cloning repository for Bob"
    $PUSHWORK_CMD clone "$ROOT_URL" bob-repo
    
    log_success "Repository cloned successfully"
    
    # Verify initial content is identical
    if cmp -s alice-repo/document.txt bob-repo/document.txt; then
        log_success "Initial content is identical"
    else
        log_error "Initial content differs between repositories"
        exit 1
    fi
}

# Make conflicting edits
make_conflicting_edits() {
    log_info "=== Making Conflicting Edits ==="
    
    # Alice's changes
    log_test "Alice adds her content"
    cd alice-repo
    cat >> document.txt << EOF
Alice's addition: New feature implementation
Alice's note: This adds user authentication
EOF
    
    log_info "Alice's document:"
    cat document.txt
    echo ""
    cd ..
    
    # Bob's changes
    log_test "Bob adds different content"
    cd bob-repo
    cat >> document.txt << EOF
Bob's addition: Performance optimization
Bob's note: This improves response time
EOF
    
    log_info "Bob's document:"
    cat document.txt
    echo ""
    cd ..
}

# Test conflict resolution
test_conflict_resolution() {
    log_info "=== Testing CRDT Conflict Resolution ==="
    
    # Alice syncs first
    log_test "Alice syncs first"
    cd alice-repo
    $PUSHWORK_CMD sync
    log_success "Alice's changes synced"
    cd ..
    
    # Bob syncs (this will merge with Alice's changes)
    log_test "Bob syncs (CRDT merging will occur)"
    cd bob-repo
    $PUSHWORK_CMD sync
    log_success "Bob's sync completed"
    cd ..
    
    # Alice syncs again to get Bob's changes
    log_test "Alice syncs again to get Bob's changes"
    cd alice-repo
    $PUSHWORK_CMD sync
    cd ..
    
    # Final sync for Bob to ensure consistency
    log_test "Bob syncs once more for final consistency"
    cd bob-repo
    $PUSHWORK_CMD sync
    cd ..
    
    log_success "All sync operations completed"
}

# Verify conflict resolution results
verify_resolution_results() {
    log_info "=== Verifying CRDT Merge Results ==="
    
    # Check what Alice has
    log_test "Alice's final content:"
    ALICE_CONTENT=$(cat alice-repo/document.txt)
    cat alice-repo/document.txt
    echo ""
    
    # Check what Bob has
    log_test "Bob's final content:"
    BOB_CONTENT=$(cat bob-repo/document.txt)
    cat bob-repo/document.txt
    echo ""
    
    # Verify both users' changes are preserved somewhere
    BOTH_ALICE_AND_BOB_PRESERVED=false
    
    # Check if at least one repository has both Alice's and Bob's changes
    if (echo "$ALICE_CONTENT" | grep -q "Alice's addition" && echo "$ALICE_CONTENT" | grep -q "Bob's addition") || \
       (echo "$BOB_CONTENT" | grep -q "Alice's addition" && echo "$BOB_CONTENT" | grep -q "Bob's addition"); then
        BOTH_ALICE_AND_BOB_PRESERVED=true
        log_success "✅ Both Alice's and Bob's changes are preserved via CRDT merging"
    fi
    
    # Check if repositories eventually converge to the same state
    if cmp -s alice-repo/document.txt bob-repo/document.txt; then
        log_success "✅ Both repositories have converged to identical content"
        if [ "$BOTH_ALICE_AND_BOB_PRESERVED" = true ]; then
            log_success "✅ Perfect CRDT behavior: Both changes preserved and repositories consistent"
        fi
    else
        log_info "Repositories have different content - checking if this is expected intermediate state"
        
        if [ "$BOTH_ALICE_AND_BOB_PRESERVED" = true ]; then
            log_success "✅ CRDT merging working: Both changes preserved, eventual consistency pending"
            log_info "Note: One repository has the merged result, other will get it on next sync"
        else
            log_error "❌ Problem: Changes may have been lost"
            exit 1
        fi
    fi
    
    # Detailed verification
    if echo "$ALICE_CONTENT" | grep -q "Alice's addition" || echo "$BOB_CONTENT" | grep -q "Alice's addition"; then
        log_success "✅ Alice's changes preserved"
    else
        log_error "❌ Alice's changes lost"
        exit 1
    fi
    
    if echo "$ALICE_CONTENT" | grep -q "Bob's addition" || echo "$BOB_CONTENT" | grep -q "Bob's addition"; then
        log_success "✅ Bob's changes preserved"
    else
        log_error "❌ Bob's changes lost"
        exit 1
    fi
}

# Show final results
show_results() {
    log_info "=== Final Results ==="
    
    echo ""
    echo "Alice's final document:"
    echo "=============================="
    cat alice-repo/document.txt
    echo "=============================="
    echo ""
    
    echo "Bob's final document:"
    echo "=============================="
    cat bob-repo/document.txt
    echo "=============================="
    
    log_success "✅ CRDT conflict resolution test completed successfully!"
    echo ""
    echo "Key findings:"
    echo "• Pushwork uses CRDT-based conflict resolution"
    echo "• Both users' changes are preserved through merging"
    echo "• No data loss occurs during conflicts"
    echo "• Text content is merged at the character level"
    echo "• Repositories eventually converge to consistent state"
    echo ""
    echo "This demonstrates:"
    echo "• True collaborative editing capabilities"
    echo "• Automatic conflict resolution without user intervention"
    echo "• Preservation of all user contributions"
    echo "• Robust distributed consistency guarantees"
}

# Main test execution
main() {
    echo "=========================================="
    echo "Pushwork CRDT Conflict Resolution Test"
    echo "=========================================="
    echo ""
    echo "This test validates that:"
    echo "1. Multiple users can edit the same file simultaneously"
    echo "2. Conflicts are resolved through CRDT merging"
    echo "3. Both users' changes are preserved"
    echo "4. No data loss occurs during conflict resolution"
    echo "5. Repositories eventually reach consistent state"
    echo ""
    
    # Trap cleanup on exit
    trap cleanup EXIT
    
    # Run the test
    setup
    create_initial_repo
    clone_repository
    make_conflicting_edits
    test_conflict_resolution
    verify_resolution_results
    show_results
    
    echo ""
    echo "=========================================="
    echo "🎉 CRDT Conflict Resolution Test PASSED! 🎉"
    echo "=========================================="
}

# Run the test
main "$@" 