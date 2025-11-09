/**
 * Benchmarks for content similarity algorithms (Levenshtein distance)
 * This is the most compute-intensive part of move detection
 */

import { Bench } from "tinybench";
import { ContentSimilarity } from "../src/utils/content-similarity";

const bench = new Bench({ time: 1000 });

// Test data: different sizes to understand scaling
const smallText = "Hello, World!";
const mediumText = "a".repeat(1000); // 1KB
const largeText = "a".repeat(10000); // 10KB
const hugeText = "a".repeat(100000); // 100KB

const smallTextModified = "Hello, World?";
const mediumTextModified = "a".repeat(950) + "b".repeat(50);
const largeTextModified = "a".repeat(9500) + "b".repeat(500);

// Small files (typical config files)
bench
  .add("small identical (13 bytes)", async () => {
    await ContentSimilarity.calculateSimilarity(smallText, smallText);
  })
  .add("small different (13 bytes)", async () => {
    await ContentSimilarity.calculateSimilarity(smallText, smallTextModified);
  });

// Medium files (typical source files)
bench
  .add("medium identical (1KB)", async () => {
    await ContentSimilarity.calculateSimilarity(mediumText, mediumText);
  })
  .add("medium different (1KB)", async () => {
    await ContentSimilarity.calculateSimilarity(mediumText, mediumTextModified);
  });

// Large files (large source files)
bench
  .add("large identical (10KB)", async () => {
    await ContentSimilarity.calculateSimilarity(largeText, largeText);
  })
  .add("large different (10KB)", async () => {
    await ContentSimilarity.calculateSimilarity(largeText, largeTextModified);
  });

// Binary content
const smallBinary = new Uint8Array([1, 2, 3, 4, 5]);
const mediumBinary = new Uint8Array(1000);
for (let i = 0; i < mediumBinary.length; i++) mediumBinary[i] = i % 256;

bench
  .add("binary small (5 bytes)", async () => {
    await ContentSimilarity.calculateSimilarity(smallBinary, smallBinary);
  })
  .add("binary medium (1KB)", async () => {
    await ContentSimilarity.calculateSimilarity(mediumBinary, mediumBinary);
  });

export default (async () => {
  await bench.warmup();
  await bench.run();
  console.table(bench.table());
})();
