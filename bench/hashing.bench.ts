/**
 * Benchmarks for content hashing
 * Used in change detection and move detection
 */

import { Bench } from "tinybench";
import { calculateContentHash } from "../src/utils/fs";

const bench = new Bench({ time: 1000 });

// Generate test data of various sizes
const tiny = "Hello, World!";
const small = "a".repeat(1024); // 1KB
const medium = "a".repeat(10240); // 10KB
const large = "a".repeat(102400); // 100KB
const huge = "a".repeat(1024000); // 1MB

// String content
bench
  .add("hash tiny string (13 bytes)", async () => {
    await calculateContentHash(tiny);
  })
  .add("hash small string (1KB)", async () => {
    await calculateContentHash(small);
  })
  .add("hash medium string (10KB)", async () => {
    await calculateContentHash(medium);
  })
  .add("hash large string (100KB)", async () => {
    await calculateContentHash(large);
  })
  .add("hash huge string (1MB)", async () => {
    await calculateContentHash(huge);
  });

// Binary content
const tinyBinary = new Uint8Array(13);
const smallBinary = new Uint8Array(1024);
const mediumBinary = new Uint8Array(10240);
const largeBinary = new Uint8Array(102400);

bench
  .add("hash tiny binary (13 bytes)", async () => {
    await calculateContentHash(tinyBinary);
  })
  .add("hash small binary (1KB)", async () => {
    await calculateContentHash(smallBinary);
  })
  .add("hash medium binary (10KB)", async () => {
    await calculateContentHash(mediumBinary);
  })
  .add("hash large binary (100KB)", async () => {
    await calculateContentHash(largeBinary);
  });

export default (async () => {
  await bench.warmup();
  await bench.run();
  console.table(bench.table());
})();
