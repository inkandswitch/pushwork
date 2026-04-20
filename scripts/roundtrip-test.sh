#!/usr/bin/env bash
# Roundtrip-test pushwork by init-ing a directory, cloning it elsewhere,
# and diffing the two trees (ignoring files that aren't synced).
#
# Usage: roundtrip-test.sh <source-dir>

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <source-dir>" >&2
  exit 1
fi

SRC=$(cd "$1" && pwd)
CLONE_DIR=$(mktemp -d -t pushwork-roundtrip-XXXXXX)/clone

echo ">> init  $SRC"
pushwork init --sub "$SRC"

URL=$(pushwork url "$SRC")
echo ">> url   $URL"

echo ">> clone $CLONE_DIR"
pushwork clone "$URL" "$CLONE_DIR" --sub

echo ">> diff  $SRC  <->  $CLONE_DIR"
if diff -r \
    --exclude=.pushwork \
    --exclude=node_modules \
    "$SRC" "$CLONE_DIR"; then
  echo ">> OK: directories match"
else
  echo ">> FAIL: directories differ" >&2
  exit 1
fi
