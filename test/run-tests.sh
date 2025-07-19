#!/bin/bash

# Pushwork Test Runner
# Provides options to run different test suites

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

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

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Show usage
show_usage() {
    echo "Pushwork Test Runner"
    echo ""
    echo "Usage: $0 [test-type]"
    echo ""
    echo "Test Types:"
    echo "  full        Run comprehensive integration tests (default)"
    echo "  clone       Run focused clone functionality tests"
    echo "  conflict    Run CRDT conflict resolution tests"
    echo "  deletion    Run deletion sync behavior tests"
    echo "  unit        Run unit tests"
    echo "  help        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0              # Run full integration tests"
    echo "  $0 full         # Run full integration tests"
    echo "  $0 clone        # Run clone-specific tests"
    echo "  $0 conflict     # Run CRDT conflict resolution tests"
    echo "  $0 unit         # Run unit tests"
    echo ""
}

# Check dependencies
check_dependencies() {
    log_info "Checking dependencies..."
    
    # Check if Node.js is available
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        echo "Please install Node.js from https://nodejs.org/"
        exit 1
    fi
    
    # Check if npm is available
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed"
        echo "Please install npm"
        exit 1
    fi
    
    # Check if jq is available (optional for some tests)
    if ! command -v jq &> /dev/null; then
        log_warning "jq is not installed - some configuration tests may be skipped"
        echo "To install jq (optional):"
        echo "  macOS: brew install jq"
        echo "  Ubuntu/Debian: apt-get install jq"
        echo "  Other: https://stedolan.github.io/jq/download/"
        echo ""
    fi
    
    log_success "Dependencies check complete"
}

# Run unit tests
run_unit_tests() {
    log_info "Running unit tests..."
    
    if [ -f "package.json" ] && grep -q "\"test\":" package.json; then
        npm test
    else
        log_warning "No unit tests configured in package.json"
        
        # Check for individual test files
        if ls test/unit/*.test.* 1> /dev/null 2>&1; then
            log_info "Found unit test files, running with jest/vitest..."
            if command -v jest &> /dev/null; then
                jest test/unit/
            elif command -v vitest &> /dev/null; then
                vitest run test/unit/
            else
                log_error "No test runner found (jest/vitest)"
                exit 1
            fi
        else
            log_warning "No unit test files found"
        fi
    fi
}

# Run clone tests
run_clone_tests() {
    log_info "Running clone functionality tests..."
    
    if [ -f "test/integration/clone-test.sh" ]; then
        ./test/integration/clone-test.sh
    else
        log_error "Clone test script not found"
        exit 1
    fi
}

# Run conflict resolution tests
run_conflict_tests() {
    log_info "Running conflict resolution tests..."
    
    if [ -f "test/integration/conflict-resolution-test.sh" ]; then
        ./test/integration/conflict-resolution-test.sh
    else
        log_error "Conflict resolution test script not found"
        exit 1
    fi
}

# Run deletion sync tests
run_deletion_tests() {
    log_info "Running deletion sync behavior tests..."
    
    if [ -f "test/integration/deletion-sync-test-simple.sh" ]; then
        ./test/integration/deletion-sync-test-simple.sh
    else
        log_error "Deletion sync test script not found"
        exit 1
    fi
}

# Run full integration tests
run_full_tests() {
    log_info "Running full integration tests..."
    
    if [ -f "test/integration/full-integration-test.sh" ]; then
        ./test/integration/full-integration-test.sh
    else
        log_error "Full integration test script not found"
        exit 1
    fi
}

# Main function
main() {
    local test_type="${1:-full}"
    
    echo "======================================"
    echo "Pushwork Test Runner"
    echo "======================================"
    
    # Change to project directory if not already there
    if [ ! -f "package.json" ]; then
        log_error "Not in project directory (package.json not found)"
        echo "Please run this script from the project root directory"
        exit 1
    fi
    
    check_dependencies
    
    case "$test_type" in
        "help"|"-h"|"--help")
            show_usage
            exit 0
            ;;
        "unit")
            run_unit_tests
            ;;
        "clone")
            run_clone_tests
            ;;
        "conflict")
            run_conflict_tests
            ;;
        "deletion")
            run_deletion_tests
            ;;
        "full")
            run_full_tests
            ;;
        *)
            log_error "Unknown test type: $test_type"
            echo ""
            show_usage
            exit 1
            ;;
    esac
    
    log_success "Test run complete!"
}

# Run main function with all arguments
main "$@" 