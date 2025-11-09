/**
 * Benchmarks for move detection algorithm
 * This is expensive because it combines similarity checking with pattern matching
 */

import { Bench } from "tinybench";
import { MoveDetector } from "../src/core/move-detection";
import { DetectedChange, ChangeType } from "../src/core/change-detection";
import { FileType } from "../src/types";

const bench = new Bench({ time: 1000 });

const detector = new MoveDetector();

// Create mock snapshot
const mockSnapshot: any = {
  timestamp: Date.now(),
  rootPath: "/test",
  files: new Map([
    ["old1.txt", { url: "url1" as any, head: [], path: "/test/old1.txt" }],
    ["old2.txt", { url: "url2" as any, head: [], path: "/test/old2.txt" }],
  ]),
  directories: new Map(),
};

// Realistic file content sizes
const smallContent = "const x = 1;".repeat(10); // ~120 bytes
const mediumContent = "export const data = { value: true };".repeat(30); // ~1KB
const largeContent = "// Comment\nfunction foo() { return 42; }\n".repeat(250); // ~10KB

// Scenario 1: Small file move (config files)
const smallFileMove: DetectedChange[] = [
  {
    path: "old1.txt",
    changeType: ChangeType.LOCAL_ONLY,
    fileType: FileType.TEXT,
    localContent: null,
    remoteContent: smallContent,
  },
  {
    path: "new1.txt",
    changeType: ChangeType.LOCAL_ONLY,
    fileType: FileType.TEXT,
    localContent: smallContent + " // modified",
    remoteContent: null,
  },
];

// Scenario 2: Medium file move (source files)
const mediumFileMove: DetectedChange[] = [
  {
    path: "old2.txt",
    changeType: ChangeType.LOCAL_ONLY,
    fileType: FileType.TEXT,
    localContent: null,
    remoteContent: mediumContent,
  },
  {
    path: "new2.txt",
    changeType: ChangeType.LOCAL_ONLY,
    fileType: FileType.TEXT,
    localContent: mediumContent.slice(0, -50) + "modified".repeat(10),
    remoteContent: null,
  },
];

// Scenario 3: Multiple candidates (ambiguous moves)
const multipleCandidates: DetectedChange[] = [
  // 3 deleted files
  {
    path: "deleted1.txt",
    changeType: ChangeType.LOCAL_ONLY,
    fileType: FileType.TEXT,
    localContent: null,
    remoteContent: smallContent,
  },
  {
    path: "deleted2.txt",
    changeType: ChangeType.LOCAL_ONLY,
    fileType: FileType.TEXT,
    localContent: null,
    remoteContent: mediumContent,
  },
  {
    path: "deleted3.txt",
    changeType: ChangeType.LOCAL_ONLY,
    fileType: FileType.TEXT,
    localContent: null,
    remoteContent: largeContent,
  },
  // 3 created files (need to find best matches)
  {
    path: "created1.txt",
    changeType: ChangeType.LOCAL_ONLY,
    fileType: FileType.TEXT,
    localContent: smallContent + "!",
    remoteContent: null,
  },
  {
    path: "created2.txt",
    changeType: ChangeType.LOCAL_ONLY,
    fileType: FileType.TEXT,
    localContent: mediumContent + "?",
    remoteContent: null,
  },
  {
    path: "created3.txt",
    changeType: ChangeType.LOCAL_ONLY,
    fileType: FileType.TEXT,
    localContent: largeContent.slice(0, -100),
    remoteContent: null,
  },
];

bench
  .add("detect move: 2 small files (~120 bytes)", async () => {
    await detector.detectMoves(smallFileMove, mockSnapshot, "/test");
  })
  .add("detect move: 2 medium files (~1KB)", async () => {
    await detector.detectMoves(mediumFileMove, mockSnapshot, "/test");
  })
  .add("detect move: 6 files, 3 candidates each", async () => {
    await detector.detectMoves(multipleCandidates, mockSnapshot, "/test");
  });

export default (async () => {
  await bench.warmup();
  await bench.run();
  console.table(bench.table());
})();
