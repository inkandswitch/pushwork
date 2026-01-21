/**
 * Sync Reliability Tests
 *
 * These tests verify sync reliability using the CLI subprocess pattern
 * (same as fuzzer.test.ts) but with convergence-based assertions.
 * 
 * Key difference from fuzzer tests: instead of fixed delays, we use
 * convergence detection to know when sync is complete.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execFile } from "child_process";
import { promisify } from "util";
import * as crypto from "crypto";

const execFilePromise = promisify(execFile);

// Path to the pushwork CLI
const PUSHWORK_CLI = path.join(__dirname, "../../dist/cli.js");

/**
 * Execute pushwork CLI command
 */
async function pushwork(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFilePromise("node", [PUSHWORK_CLI, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return result;
  } catch (error: any) {
    throw new Error(
      `pushwork ${args.join(" ")} failed: ${error.message}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`
    );
  }
}

/**
 * Compute hash of all files in a directory (excluding .pushwork)
 */
async function hashDirectory(dirPath: string): Promise<string> {
  const files = await getAllFiles(dirPath);
  const hash = crypto.createHash("sha256");

  files.sort();

  for (const file of files) {
    if (file.includes(".pushwork")) continue;

    const fullPath = path.join(dirPath, file);
    const content = await fs.readFile(fullPath);

    hash.update(file);
    hash.update(content);
  }

  return hash.digest("hex");
}

/**
 * Recursively get all files in a directory
 */
async function getAllFiles(
  dirPath: string,
  basePath: string = dirPath
): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (entry.isDirectory()) {
      if (entry.name === ".pushwork") continue;
      const subFiles = await getAllFiles(fullPath, basePath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

/**
 * Check if a path exists
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync until repos converge or max rounds reached.
 * Returns the number of rounds it took to converge, or throws if it didn't.
 * 
 * This is the key helper - instead of fixed delays, we sync until convergence.
 */
async function syncUntilConverged(
  repoA: string,
  repoB: string,
  options: {
    maxRounds?: number;
    timeoutMs?: number;
  } = {}
): Promise<{ rounds: number; hashA: string; hashB: string }> {
  const { maxRounds = 5, timeoutMs = 30000 } = options;
  const startTime = Date.now();

  for (let round = 1; round <= maxRounds; round++) {
    if (Date.now() - startTime > timeoutMs) {
      const hashA = await hashDirectory(repoA);
      const hashB = await hashDirectory(repoB);
      throw new Error(
        `Sync timeout after ${round - 1} rounds and ${Date.now() - startTime}ms. ` +
        `hashA=${hashA.slice(0, 8)}, hashB=${hashB.slice(0, 8)}`
      );
    }

    // Sync both repos
    await pushwork(["sync"], repoA);
    await pushwork(["sync"], repoB);

    // Check if converged
    const hashA = await hashDirectory(repoA);
    const hashB = await hashDirectory(repoB);

    if (hashA === hashB) {
      return { rounds: round, hashA, hashB };
    }
  }

  const hashA = await hashDirectory(repoA);
  const hashB = await hashDirectory(repoB);
  throw new Error(
    `Failed to converge after ${maxRounds} sync rounds. ` +
    `hashA=${hashA.slice(0, 8)}, hashB=${hashB.slice(0, 8)}`
  );
}

describe("Sync Reliability Tests", () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(() => {
    cleanup();
  });

  describe("Basic Two-Repo Sync", () => {
    /**
     * STRICT TEST: Check state immediately after clone, no extra syncs.
     * This should expose the same issues as the fuzzer.
     */
    it("should have matching state immediately after clone (strict)", async () => {
      const repoA = path.join(tmpDir, "repo-a");
      const repoB = path.join(tmpDir, "repo-b");
      await fs.mkdir(repoA);
      await fs.mkdir(repoB);

      // Create file and init A
      await fs.writeFile(path.join(repoA, "test.txt"), "Hello from A");
      await pushwork(["init", "."], repoA);

      // Clone to B (no extra syncs!)
      const { stdout: rootUrl } = await pushwork(["url"], repoA);
      await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);

      // STRICT: Check immediately, no syncUntilConverged
      const hashA = await hashDirectory(repoA);
      const hashB = await hashDirectory(repoB);

      // Debug output if they don't match
      if (hashA !== hashB) {
        const filesA = await getAllFiles(repoA);
        const filesB = await getAllFiles(repoB);
        console.log("MISMATCH DETECTED:");
        console.log("  repoA files:", filesA.filter(f => !f.includes(".pushwork")));
        console.log("  repoB files:", filesB.filter(f => !f.includes(".pushwork")));
        console.log("  hashA:", hashA.slice(0, 16));
        console.log("  hashB:", hashB.slice(0, 16));
      }

      expect(hashA).toBe(hashB);

      // Verify file exists in both
      expect(await pathExists(path.join(repoA, "test.txt"))).toBe(true);
      expect(await pathExists(path.join(repoB, "test.txt"))).toBe(true);

      // Verify content matches
      const contentA = await fs.readFile(path.join(repoA, "test.txt"), "utf-8");
      const contentB = await fs.readFile(path.join(repoB, "test.txt"), "utf-8");
      expect(contentA).toBe("Hello from A");
      expect(contentB).toBe("Hello from A");
    }, 30000);

    it("should sync a file from A to B (with convergence)", async () => {
      const repoA = path.join(tmpDir, "repo-a");
      const repoB = path.join(tmpDir, "repo-b");
      await fs.mkdir(repoA);
      await fs.mkdir(repoB);

      // Create file and init A
      await fs.writeFile(path.join(repoA, "test.txt"), "Hello from A");
      await pushwork(["init", "."], repoA);

      // Clone to B
      const { stdout: rootUrl } = await pushwork(["url"], repoA);
      await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);

      // Verify convergence (allows retries)
      const { rounds, hashA, hashB } = await syncUntilConverged(repoA, repoB);

      expect(hashA).toBe(hashB);
      expect(rounds).toBeLessThanOrEqual(2); // Should converge quickly

      // Verify content
      const contentA = await fs.readFile(path.join(repoA, "test.txt"), "utf-8");
      const contentB = await fs.readFile(path.join(repoB, "test.txt"), "utf-8");
      expect(contentA).toBe(contentB);
      expect(contentA).toBe("Hello from A");
    }, 30000);

    it("should sync a new file added to B back to A", async () => {
      const repoA = path.join(tmpDir, "repo-a");
      const repoB = path.join(tmpDir, "repo-b");
      await fs.mkdir(repoA);
      await fs.mkdir(repoB);

      // Init A with initial file
      await fs.writeFile(path.join(repoA, "initial.txt"), "initial");
      await pushwork(["init", "."], repoA);

      // Clone to B
      const { stdout: rootUrl } = await pushwork(["url"], repoA);
      await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);

      // Initial convergence
      await syncUntilConverged(repoA, repoB);

      // B creates new file
      await fs.writeFile(path.join(repoB, "from-b.txt"), "Created by B");

      // Sync until converged
      const { rounds } = await syncUntilConverged(repoA, repoB);

      expect(rounds).toBeLessThanOrEqual(3);

      // Verify A got B's file
      expect(await pathExists(path.join(repoA, "from-b.txt"))).toBe(true);
      const content = await fs.readFile(path.join(repoA, "from-b.txt"), "utf-8");
      expect(content).toBe("Created by B");
    }, 30000);

    it("should sync subdirectories correctly", async () => {
      const repoA = path.join(tmpDir, "repo-a");
      const repoB = path.join(tmpDir, "repo-b");
      await fs.mkdir(repoA);
      await fs.mkdir(repoB);

      // Create nested structure in A
      await fs.mkdir(path.join(repoA, "subdir"), { recursive: true });
      await fs.writeFile(path.join(repoA, "subdir", "nested.txt"), "Nested content");
      await pushwork(["init", "."], repoA);

      // Clone to B
      const { stdout: rootUrl } = await pushwork(["url"], repoA);
      await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);

      // Verify convergence
      const { rounds } = await syncUntilConverged(repoA, repoB);

      expect(rounds).toBeLessThanOrEqual(2);

      // Verify B got the nested file
      expect(await pathExists(path.join(repoB, "subdir", "nested.txt"))).toBe(true);
      const content = await fs.readFile(path.join(repoB, "subdir", "nested.txt"), "utf-8");
      expect(content).toBe("Nested content");
    }, 30000);
  });

  describe("Concurrent Operations", () => {
    it("should handle concurrent file creation on both sides", async () => {
      const repoA = path.join(tmpDir, "repo-a");
      const repoB = path.join(tmpDir, "repo-b");
      await fs.mkdir(repoA);
      await fs.mkdir(repoB);

      // Init A
      await fs.writeFile(path.join(repoA, "initial.txt"), "initial");
      await pushwork(["init", "."], repoA);

      // Clone to B
      const { stdout: rootUrl } = await pushwork(["url"], repoA);
      await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);

      // Initial convergence
      await syncUntilConverged(repoA, repoB);

      // Both create files concurrently (before syncing)
      await fs.writeFile(path.join(repoA, "file-a.txt"), "From A");
      await fs.writeFile(path.join(repoB, "file-b.txt"), "From B");

      // Sync until converged
      const { rounds } = await syncUntilConverged(repoA, repoB);

      expect(rounds).toBeLessThanOrEqual(3);

      // Both should have both files
      expect(await pathExists(path.join(repoA, "file-a.txt"))).toBe(true);
      expect(await pathExists(path.join(repoA, "file-b.txt"))).toBe(true);
      expect(await pathExists(path.join(repoB, "file-a.txt"))).toBe(true);
      expect(await pathExists(path.join(repoB, "file-b.txt"))).toBe(true);
    }, 30000);

    it("should handle file modification sync", async () => {
      const repoA = path.join(tmpDir, "repo-a");
      const repoB = path.join(tmpDir, "repo-b");
      await fs.mkdir(repoA);
      await fs.mkdir(repoB);

      // Init A with file
      await fs.writeFile(path.join(repoA, "shared.txt"), "Original");
      await pushwork(["init", "."], repoA);

      // Clone to B
      const { stdout: rootUrl } = await pushwork(["url"], repoA);
      await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);

      // Initial convergence
      await syncUntilConverged(repoA, repoB);

      // A modifies the file
      await fs.writeFile(path.join(repoA, "shared.txt"), "Modified by A");

      // Sync until converged
      const { rounds } = await syncUntilConverged(repoA, repoB);

      expect(rounds).toBeLessThanOrEqual(3);

      // B should have the modification
      const contentB = await fs.readFile(path.join(repoB, "shared.txt"), "utf-8");
      expect(contentB).toBe("Modified by A");
    }, 30000);

    it("should handle file deletion sync", async () => {
      const repoA = path.join(tmpDir, "repo-a");
      const repoB = path.join(tmpDir, "repo-b");
      await fs.mkdir(repoA);
      await fs.mkdir(repoB);

      // Init A with file
      await fs.writeFile(path.join(repoA, "to-delete.txt"), "Will be deleted");
      await pushwork(["init", "."], repoA);

      // Clone to B
      const { stdout: rootUrl } = await pushwork(["url"], repoA);
      await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);

      // Initial convergence
      await syncUntilConverged(repoA, repoB);

      // Verify B has the file
      expect(await pathExists(path.join(repoB, "to-delete.txt"))).toBe(true);

      // A deletes the file
      await fs.unlink(path.join(repoA, "to-delete.txt"));

      // Sync until converged
      const { rounds } = await syncUntilConverged(repoA, repoB);

      expect(rounds).toBeLessThanOrEqual(3);

      // File should be deleted in B
      expect(await pathExists(path.join(repoB, "to-delete.txt"))).toBe(false);
    }, 30000);
  });

  describe("Move/Rename Detection", () => {
    it("should handle file rename", async () => {
      const repoA = path.join(tmpDir, "repo-a");
      const repoB = path.join(tmpDir, "repo-b");
      await fs.mkdir(repoA);
      await fs.mkdir(repoB);

      // Init A with file
      const content = "This content will be used for similarity detection during move";
      await fs.writeFile(path.join(repoA, "original.txt"), content);
      await pushwork(["init", "."], repoA);

      // Clone to B
      const { stdout: rootUrl } = await pushwork(["url"], repoA);
      await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);

      // Initial convergence
      await syncUntilConverged(repoA, repoB);

      // A renames the file
      await fs.rename(
        path.join(repoA, "original.txt"),
        path.join(repoA, "renamed.txt")
      );

      // Sync until converged
      const { rounds } = await syncUntilConverged(repoA, repoB);

      expect(rounds).toBeLessThanOrEqual(3);

      // Verify both repos have renamed.txt and not original.txt
      expect(await pathExists(path.join(repoA, "original.txt"))).toBe(false);
      expect(await pathExists(path.join(repoA, "renamed.txt"))).toBe(true);
      expect(await pathExists(path.join(repoB, "original.txt"))).toBe(false);
      expect(await pathExists(path.join(repoB, "renamed.txt"))).toBe(true);

      // Verify content preserved
      const contentB = await fs.readFile(path.join(repoB, "renamed.txt"), "utf-8");
      expect(contentB).toBe(content);
    }, 30000);
  });
});
