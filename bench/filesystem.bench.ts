/**
 * Benchmarks for file system operations
 * These are critical for sync performance
 */

import { Bench } from "tinybench";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import {
  readFileContent,
  pathExists,
  listDirectory,
  isTextFile,
} from "../src/utils/fs";

const bench = new Bench({ time: 1000 });

// Setup test directory
const testDir = join(tmpdir(), "pushwork-bench-fs-" + Date.now());
mkdirSync(testDir, { recursive: true });

// Create test files of realistic sizes
const smallFile = join(testDir, "small.txt");
const mediumFile = join(testDir, "medium.ts");
const largeFile = join(testDir, "large.json");
const binaryFile = join(testDir, "image.bin");

writeFileSync(smallFile, "Hello, World!"); // 13 bytes
writeFileSync(
  mediumFile,
  "export const data = " + JSON.stringify({ data: "a".repeat(5000) })
); // ~5KB
writeFileSync(largeFile, JSON.stringify({ data: "a".repeat(50000) })); // ~50KB
writeFileSync(binaryFile, Buffer.alloc(10240)); // 10KB binary

// Create nested directory structure
const nestedDir = join(testDir, "nested");
mkdirSync(join(nestedDir, "a", "b", "c"), { recursive: true });
for (let i = 0; i < 20; i++) {
  writeFileSync(join(nestedDir, `file${i}.txt`), `content ${i}`.repeat(100));
  writeFileSync(
    join(nestedDir, "a", `file${i}.txt`),
    `content ${i}`.repeat(100)
  );
}

// Realistic filesystem operations
bench
  .add("read small file (13 bytes)", async () => {
    await readFileContent(smallFile);
  })
  .add("read medium file (5KB)", async () => {
    await readFileContent(mediumFile);
  })
  .add("read large file (50KB)", async () => {
    await readFileContent(largeFile);
  })
  .add("detect text vs binary (text)", async () => {
    await isTextFile(smallFile);
  })
  .add("detect text vs binary (binary)", async () => {
    await isTextFile(binaryFile);
  })
  .add("list directory recursive (40 files)", async () => {
    await listDirectory(nestedDir, true);
  });

export default (async () => {
  await bench.warmup();
  await bench.run();
  console.table(bench.table());

  // Cleanup
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
})();
