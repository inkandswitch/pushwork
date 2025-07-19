#!/bin/bash

pushwork() {
    node /Users/pvh/dev/pushwork/dist/cli.js $@
}

set -e

rm -rf /tmp/test-sync
mkdir /tmp/test-sync
cd /tmp/test-sync
mkdir alice

cd alice
echo Hello > file1.txt
pushwork init . --sync-server ws://localhost:3030 --sync-server-storage-id 1d89eba7-f7a4-4e8e-80f2-5f4e2406f507

cd ..
pushwork clone --sync-server ws://localhost:3030 --sync-server-storage-id 1d89eba7-f7a4-4e8e-80f2-5f4e2406f507 `jq -r .rootDirectoryUrl ./alice/.pushwork/snapshot.json` bob

cd bob
echo Bob >> file1.txt

cd ../alice
echo Alice >> file1.txt
pushwork sync

cd ../bob
pushwork sync

echo "Bob's file1.txt (should be Hello BobAlice):"
cat file1.txt