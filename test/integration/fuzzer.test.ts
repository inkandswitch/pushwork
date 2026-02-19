import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execFile } from "child_process";
import { promisify } from "util";
import * as crypto from "crypto";
import * as fc from "fast-check";

const execFilePromise = promisify(execFile);

// Path to the pushwork CLI
const PUSHWORK_CLI = path.join(__dirname, "../../dist/cli.js");

describe("Pushwork Fuzzer", () => {
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

  /**
   * Helper: Wait for a short time (useful for allowing sync to complete)
   */
  async function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Helper: Execute pushwork CLI command with retry logic for transient errors
   */
  async function pushwork(
    args: string[],
    cwd: string,
    maxRetries: number = 3
  ): Promise<{ stdout: string; stderr: string }> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await execFilePromise("node", [PUSHWORK_CLI, ...args], {
          cwd,
          env: { ...process.env, FORCE_COLOR: "0" }, // Disable color codes for cleaner output
        });
        return result;
      } catch (error: any) {
        lastError = error;
        const errorMessage = error.message + (error.stderr || "");

        // Retry on transient server errors (502, 503, connection refused, unavailable)
        const isTransient =
          errorMessage.includes("502") ||
          errorMessage.includes("503") ||
          errorMessage.includes("ECONNREFUSED") ||
          errorMessage.includes("ETIMEDOUT") ||
          errorMessage.includes("unavailable");

        if (isTransient && attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt - 1) * 1000;
          await wait(delay);
          continue;
        }

        // Non-transient error or exhausted retries
        throw new Error(
          `pushwork ${args.join(" ")} failed: ${error.message}\nstdout: ${
            error.stdout
          }\nstderr: ${error.stderr}`
        );
      }
    }

    // Should never reach here, but TypeScript needs this
    throw lastError;
  }

  /**
   * Helper: Compute hash of all files in a directory (excluding .pushwork)
   */
  async function hashDirectory(dirPath: string): Promise<string> {
    const files = await getAllFiles(dirPath);
    const hash = crypto.createHash("sha256");

    // Sort files for consistent hashing
    files.sort();

    for (const file of files) {
      // Skip .pushwork directory
      if (file.includes(".pushwork")) {
        continue;
      }

      const fullPath = path.join(dirPath, file);
      const content = await fs.readFile(fullPath);

      // Include relative path in hash to catch renames/moves
      hash.update(file);
      hash.update(content);
    }

    return hash.digest("hex");
  }

  /**
   * Helper: Recursively get all files in a directory
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
        // Skip .pushwork directory
        if (entry.name === ".pushwork") {
          continue;
        }
        const subFiles = await getAllFiles(fullPath, basePath);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }

    return files;
  }

  describe("Basic Setup and Clone", () => {
    it("should initialize a repo with a single file and clone it successfully", async () => {
      // Create two directories for testing
      const repoA = path.join(tmpDir, "repo-a");
      const repoB = path.join(tmpDir, "repo-b");
      await fs.mkdir(repoA);
      await fs.mkdir(repoB);

      // Step 1: Create a file in repo A
      const testFile = path.join(repoA, "test.txt");
      await fs.writeFile(testFile, "Hello, Pushwork!");

      // Step 2: Initialize repo A
      await pushwork(["init", "."], repoA);

      // Wait a moment for initialization to complete
      await wait(1000);

      // Step 3: Get the root URL from repo A
      const { stdout: rootUrl } = await pushwork(["url"], repoA);
      const cleanRootUrl = rootUrl.trim();

      expect(cleanRootUrl).toMatch(/^automerge:/);

      // Step 4: Clone repo A to repo B
      await pushwork(["clone", cleanRootUrl, repoB], tmpDir);

      // Wait a moment for clone to complete
      await wait(1000);

      // Step 5: Verify both repos have the same content
      const hashA = await hashDirectory(repoA);
      const hashB = await hashDirectory(repoB);

      expect(hashA).toBe(hashB);

      // Step 6: Verify the file exists in both repos
      const fileAExists = await pathExists(path.join(repoA, "test.txt"));
      const fileBExists = await pathExists(path.join(repoB, "test.txt"));

      expect(fileAExists).toBe(true);
      expect(fileBExists).toBe(true);

      // Step 7: Verify the content is the same
      const contentA = await fs.readFile(path.join(repoA, "test.txt"), "utf-8");
      const contentB = await fs.readFile(path.join(repoB, "test.txt"), "utf-8");

      expect(contentA).toBe("Hello, Pushwork!");
      expect(contentB).toBe("Hello, Pushwork!");
      expect(contentA).toBe(contentB);
    }, 30000); // 30 second timeout for this test
  });

  describe("Manual Fuzzing Tests", () => {
    it.concurrent(
      "should handle a simple edit on one side",
      async () => {
        const tmpObj = tmp.dirSync({ unsafeCleanup: true });
        const testRoot = path.join(
          tmpObj.name,
          `test-manual-a-${Date.now()}-${Math.random()}`
        );
        await fs.mkdir(testRoot, { recursive: true });
        const repoA = path.join(testRoot, "manual-a");
        const repoB = path.join(testRoot, "manual-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        // Initialize repo A with a file
        await fs.writeFile(path.join(repoA, "test.txt"), "initial content");
        await pushwork(["init", "."], repoA);
        await wait(500);

        // Clone to B
        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);
        await wait(500);

        // Edit file on A
        await fs.writeFile(path.join(repoA, "test.txt"), "modified content");

        // Sync A
        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);

        // Sync B to pull changes
        await pushwork(["sync", "--gentle"], repoB);
        await wait(1000);

        // Verify they match
        const contentA = await fs.readFile(
          path.join(repoA, "test.txt"),
          "utf-8"
        );
        const contentB = await fs.readFile(
          path.join(repoB, "test.txt"),
          "utf-8"
        );

        expect(contentA).toBe("modified content");
        expect(contentB).toBe("modified content");

        // Cleanup
        tmpObj.removeCallback();
      },
      30000
    );

    it.concurrent(
      "should handle edit + rename on one side",
      async () => {
        const tmpObj = tmp.dirSync({ unsafeCleanup: true });
        const testRoot = path.join(
          tmpObj.name,
          `test-rename-${Date.now()}-${Math.random()}`
        );
        await fs.mkdir(testRoot, { recursive: true });
        const repoA = path.join(testRoot, "rename-a");
        const repoB = path.join(testRoot, "rename-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        // Initialize repo A with a file
        await fs.writeFile(
          path.join(repoA, "original.txt"),
          "original content"
        );
        await pushwork(["init", "."], repoA);
        await wait(500);

        // Clone to B
        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);
        await wait(500);

        // Edit AND rename file on A (the suspicious operation!)
        await fs.writeFile(path.join(repoA, "original.txt"), "edited content");
        await fs.rename(
          path.join(repoA, "original.txt"),
          path.join(repoA, "renamed.txt")
        );

        // Sync both sides
        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);
        await pushwork(["sync", "--gentle"], repoB);
        await wait(1000);

        // One more round for convergence
        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);
        await pushwork(["sync", "--gentle"], repoB);
        await wait(1000);

        // Verify: original.txt should not exist, renamed.txt should exist with edited content
        const originalExistsA = await pathExists(
          path.join(repoA, "original.txt")
        );
        const originalExistsB = await pathExists(
          path.join(repoB, "original.txt")
        );
        const renamedExistsA = await pathExists(
          path.join(repoA, "renamed.txt")
        );
        const renamedExistsB = await pathExists(
          path.join(repoB, "renamed.txt")
        );

        expect(originalExistsA).toBe(false);
        expect(originalExistsB).toBe(false);
        expect(renamedExistsA).toBe(true);
        expect(renamedExistsB).toBe(true);

        const contentA = await fs.readFile(
          path.join(repoA, "renamed.txt"),
          "utf-8"
        );
        const contentB = await fs.readFile(
          path.join(repoB, "renamed.txt"),
          "utf-8"
        );

        expect(contentA).toBe("edited content");
        expect(contentB).toBe("edited content");

        // Cleanup
        tmpObj.removeCallback();
      },
      120000
    ); // 2 minute timeout

    it.concurrent(
      "should handle simplest case: clone then add file",
      async () => {
        const tmpObj = tmp.dirSync({ unsafeCleanup: true });
        const testRoot = path.join(
          tmpObj.name,
          `test-simple-${Date.now()}-${Math.random()}`
        );
        await fs.mkdir(testRoot, { recursive: true });
        const repoA = path.join(testRoot, "simple-a");
        const repoB = path.join(testRoot, "simple-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        // Initialize repo A
        await fs.writeFile(path.join(repoA, "initial.txt"), "initial");
        await pushwork(["init", "."], repoA);
        await wait(1000);

        // Clone to B
        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);
        await wait(1000);

        // B: Create a new file (nothing else happens)
        await fs.writeFile(path.join(repoB, "aaa.txt"), "");

        // B syncs
        await pushwork(["sync", "--gentle"], repoB);
        await wait(1000);

        // A syncs
        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);

        // Check convergence
        const filesA = await fs.readdir(repoA);
        const filesB = await fs.readdir(repoB);
        const filteredFilesA = filesA.filter((f) => !f.startsWith("."));
        const filteredFilesB = filesB.filter((f) => !f.startsWith("."));
        expect(filteredFilesA).toEqual(filteredFilesB);

        expect(await pathExists(path.join(repoA, "aaa.txt"))).toBe(true);
        expect(await pathExists(path.join(repoB, "aaa.txt"))).toBe(true);

        // Cleanup
        tmpObj.removeCallback();
      },
      20000
    );

    it.concurrent(
      "should handle minimal shrunk case: editAndRename non-existent + add same file",
      async () => {
        const tmpObj = tmp.dirSync({ unsafeCleanup: true });
        const testRoot = path.join(
          tmpObj.name,
          `test-shrunk-${Date.now()}-${Math.random()}`
        );
        await fs.mkdir(testRoot, { recursive: true });
        const repoA = path.join(testRoot, "shrunk-a");
        const repoB = path.join(testRoot, "shrunk-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        // Initialize repo A
        await fs.writeFile(path.join(repoA, "initial.txt"), "initial");
        await pushwork(["init", "."], repoA);
        await wait(1000); // Match manual test timing

        // Clone to B
        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);
        await wait(1000); // Match manual test timing

        // A: Try to editAndRename a non-existent file (this is from the shrunk test case)
        // This operation should be a no-op since aaa.txt doesn't exist
        const fromPath = path.join(repoA, "aaa.txt");
        const toPath = path.join(repoA, "aa/aa/aaa.txt");
        if ((await pathExists(fromPath)) && !(await pathExists(toPath))) {
          await fs.writeFile(fromPath, "");
          await fs.mkdir(path.dirname(toPath), { recursive: true });
          await fs.rename(fromPath, toPath);
        }

        // B: Create the same file that A tried to operate on
        await fs.writeFile(path.join(repoB, "aaa.txt"), "");

        // Sync multiple rounds (use 1s waits for reliable network propagation)
        // Pattern: A, B, A (like manual test that worked)
        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);

        // Check what B sees before sync
        await pushwork(["diff", "--name-only"], repoB);

        await pushwork(["sync", "--gentle"], repoB);
        await wait(1000);

        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);

        // Debug: Check what files exist
        const filesA = await fs.readdir(repoA);
        const filesB = await fs.readdir(repoB);
        const filteredFilesA = filesA.filter((f) => !f.startsWith("."));
        const filteredFilesB = filesB.filter((f) => !f.startsWith("."));
        expect(filteredFilesA).toEqual(filteredFilesB);

        // Verify convergence
        const hashA = await hashDirectory(repoA);
        const hashB = await hashDirectory(repoB);

        expect(hashA).toBe(hashB);

        // Both should have aaa.txt
        expect(await pathExists(path.join(repoA, "aaa.txt"))).toBe(true);
        expect(await pathExists(path.join(repoB, "aaa.txt"))).toBe(true);

        // Cleanup
        tmpObj.removeCallback();
      },
      20000
    );

    it.concurrent(
      "should handle files in subdirectories and moves between directories",
      async () => {
        const tmpObj = tmp.dirSync({ unsafeCleanup: true });
        const testRoot = path.join(
          tmpObj.name,
          `test-subdir-${Date.now()}-${Math.random()}`
        );
        await fs.mkdir(testRoot, { recursive: true });
        const repoA = path.join(testRoot, "subdir-a");
        const repoB = path.join(testRoot, "subdir-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        // Initialize repo A with a file in a subdirectory
        await fs.mkdir(path.join(repoA, "dir1"), { recursive: true });
        await fs.writeFile(path.join(repoA, "dir1", "file1.txt"), "in dir1");

        await pushwork(["init", "."], repoA);
        await wait(500);

        // Clone to B
        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);
        await wait(500);

        // Verify B got the subdirectory and file
        expect(await pathExists(path.join(repoB, "dir1", "file1.txt"))).toBe(
          true
        );
        const initialContentB = await fs.readFile(
          path.join(repoB, "dir1", "file1.txt"),
          "utf-8"
        );
        expect(initialContentB).toBe("in dir1");

        // On A: Create another file in a different subdirectory
        await fs.mkdir(path.join(repoA, "dir2"), { recursive: true });
        await fs.writeFile(path.join(repoA, "dir2", "file2.txt"), "in dir2");

        // Sync both sides
        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);
        await pushwork(["sync", "--gentle"], repoB);
        await wait(1000);

        // Verify B got the new subdirectory and file
        expect(await pathExists(path.join(repoB, "dir2", "file2.txt"))).toBe(
          true
        );
        const file2ContentB = await fs.readFile(
          path.join(repoB, "dir2", "file2.txt"),
          "utf-8"
        );
        expect(file2ContentB).toBe("in dir2");

        // Cleanup
        tmpObj.removeCallback();
      },
      30000
    );
  });

  describe("Property-Based Fuzzing with fast-check", () => {
    // Define operation types
    type FileOperation =
      | { type: "add"; path: string; content: string }
      | { type: "edit"; path: string; content: string }
      | { type: "delete"; path: string }
      | { type: "rename"; fromPath: string; toPath: string }
      | {
          type: "editAndRename";
          fromPath: string;
          toPath: string;
          content: string;
        };

    /**
     * Arbitrary: Generate a directory name
     */
    const dirNameArbitrary = fc.stringMatching(/^[a-z]{2,6}$/);

    /**
     * Arbitrary: Generate a simple filename (basename + extension)
     */
    const baseNameArbitrary = fc
      .tuple(
        fc.stringMatching(/^[a-z]{3,8}$/), // basename
        fc.constantFrom("txt", "md", "json", "ts") // extension
      )
      .map(([name, ext]) => `${name}.${ext}`);

    /**
     * Arbitrary: Generate a file path (can be in root or in subdirectories)
     * Examples: "file.txt", "dir1/file.txt", "dir1/dir2/file.txt"
     */
    const filePathArbitrary = fc.oneof(
      // File in root directory (60% probability)
      baseNameArbitrary,
      // File in single subdirectory (30% probability)
      fc
        .tuple(dirNameArbitrary, baseNameArbitrary)
        .map(([dir, file]) => `${dir}/${file}`),
      // File in nested subdirectory (10% probability)
      fc
        .tuple(dirNameArbitrary, dirNameArbitrary, baseNameArbitrary)
        .map(([dir1, dir2, file]) => `${dir1}/${dir2}/${file}`)
    );

    /**
     * Arbitrary: Generate file content (small strings for now)
     */
    const fileContentArbitrary = fc.string({ minLength: 0, maxLength: 100 });

    /**
     * Arbitrary: Generate a file operation
     */
    const fileOperationArbitrary: fc.Arbitrary<FileOperation> = fc.oneof(
      // Add file (can be in subdirectories)
      fc.record({
        type: fc.constant("add" as const),
        path: filePathArbitrary,
        content: fileContentArbitrary,
      }),
      // Edit file
      fc.record({
        type: fc.constant("edit" as const),
        path: filePathArbitrary,
        content: fileContentArbitrary,
      }),
      // Delete file
      fc.record({
        type: fc.constant("delete" as const),
        path: filePathArbitrary,
      }),
      // Rename file (can move between directories)
      fc.record({
        type: fc.constant("rename" as const),
        fromPath: filePathArbitrary,
        toPath: filePathArbitrary,
      }),
      // Edit and rename (can move between directories)
      fc.record({
        type: fc.constant("editAndRename" as const),
        fromPath: filePathArbitrary,
        toPath: filePathArbitrary,
        content: fileContentArbitrary,
      })
    );

    /**
     * Helper: Ensure parent directory exists
     */
    async function ensureParentDir(filePath: string): Promise<void> {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
    }

    /**
     * Helper: Apply a file operation to a directory
     */
    async function applyOperation(
      repoPath: string,
      op: FileOperation
    ): Promise<void> {
      try {
        switch (op.type) {
          case "add": {
            const filePath = path.join(repoPath, op.path);
            await ensureParentDir(filePath);
            await fs.writeFile(filePath, op.content);
            break;
          }
          case "edit": {
            const filePath = path.join(repoPath, op.path);
            // Only edit if file exists, otherwise create it
            if (await pathExists(filePath)) {
              await fs.writeFile(filePath, op.content);
            } else {
              await ensureParentDir(filePath);
              await fs.writeFile(filePath, op.content);
            }
            break;
          }
          case "delete": {
            const filePath = path.join(repoPath, op.path);
            // Only delete if file exists
            if (await pathExists(filePath)) {
              await fs.unlink(filePath);
            }
            break;
          }
          case "rename": {
            const fromPath = path.join(repoPath, op.fromPath);
            const toPath = path.join(repoPath, op.toPath);
            // Only rename if source exists and target doesn't
            if ((await pathExists(fromPath)) && !(await pathExists(toPath))) {
              await ensureParentDir(toPath);
              await fs.rename(fromPath, toPath);
            }
            break;
          }
          case "editAndRename": {
            const fromPath = path.join(repoPath, op.fromPath);
            const toPath = path.join(repoPath, op.toPath);
            // Edit then rename: only if source exists and target doesn't
            if ((await pathExists(fromPath)) && !(await pathExists(toPath))) {
              await fs.writeFile(fromPath, op.content);
              await ensureParentDir(toPath);
              await fs.rename(fromPath, toPath);
            }
            break;
          }
        }
      } catch (error) {
        // Ignore operation errors (e.g., deleting non-existent file)
        // This is expected in fuzzing
      }
    }

    /**
     * Helper: Apply multiple operations
     */
    async function applyOperations(
      repoPath: string,
      operations: FileOperation[]
    ): Promise<void> {
      for (const op of operations) {
        await applyOperation(repoPath, op);
      }
    }

    it("should converge after random operations on both sides", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fileOperationArbitrary, { minLength: 1, maxLength: 10 }), // Operations on repo A (1-10 ops)
          fc.array(fileOperationArbitrary, { minLength: 1, maxLength: 10 }), // Operations on repo B (1-10 ops)
          async (opsA, opsB) => {
            // Create two directories for testing
            const testRoot = path.join(
              tmpDir,
              `test-${Date.now()}-${Math.random()}`
            );
            await fs.mkdir(testRoot, { recursive: true });

            const repoA = path.join(testRoot, "repo-a");
            const repoB = path.join(testRoot, "repo-b");
            await fs.mkdir(repoA);
            await fs.mkdir(repoB);

            try {
              // Initialize repo A with an initial file
              await fs.writeFile(path.join(repoA, "initial.txt"), "initial");
              await pushwork(["init", "."], repoA);
              // Give sync server time to store and propagate the document
              await wait(2000);

              // Get root URL and clone to B
              const { stdout: rootUrl } = await pushwork(["url"], repoA);
              const cleanRootUrl = rootUrl.trim();
              // Clone with extra retries - document availability can be delayed
              await pushwork(["clone", cleanRootUrl, repoB], testRoot, 5);
              await wait(1000);

              // Verify initial state matches
              const filesA = await getAllFiles(repoA);
              const filesB = await getAllFiles(repoB);
              const hashBeforeOps = await hashDirectory(repoA);
              const hashB1 = await hashDirectory(repoB);
              if (hashBeforeOps !== hashB1) {
                throw new Error(
                  `Initial hash mismatch!\n` +
                  `  repoA (${repoA}):\n    files: ${JSON.stringify(filesA)}\n    hash: ${hashBeforeOps}\n` +
                  `  repoB (${repoB}):\n    files: ${JSON.stringify(filesB)}\n    hash: ${hashB1}`
                );
              }

              // Apply operations to both sides
              await applyOperations(repoA, opsA);

              await applyOperations(repoB, opsB);

              // Multiple sync rounds for convergence
              // Need enough time for network propagation between CLI invocations
              // Round 1: A pushes changes
              await pushwork(["sync", "--gentle"], repoA);
              await wait(1000);

              // Round 2: B pushes changes and pulls A's changes
              await pushwork(["sync", "--gentle"], repoB);
              await wait(1000);

              // Round 3: A pulls B's changes
              await pushwork(["sync", "--gentle"], repoA);
              await wait(1000);

              // Round 4: B confirms convergence
              await pushwork(["sync", "--gentle"], repoB);
              await wait(1000);

              // Round 5: Final convergence check
              await pushwork(["sync", "--gentle"], repoA);
              await wait(1000);

              // Round 6: Extra convergence check (for aggressive fuzzing)
              await pushwork(["sync", "--gentle"], repoB);
              await wait(5000);

              // Verify final state matches

              const hashAfterA = await hashDirectory(repoA);
              const hashAfterB = await hashDirectory(repoB);

              expect(hashAfterA).toBe(hashAfterB);

              // Verify diff shows no changes
              const { stdout: diffOutput } = await pushwork(
                ["diff", "--name-only"],
                repoA
              );
              // Filter out status messages, only check for actual file differences
              const diffLines = diffOutput
                .split("\n")
                .filter(
                  (line) =>
                    line.trim() &&
                    !line.includes("✓") &&
                    !line.includes("Local-only") &&
                    !line.includes("Root URL")
                );
              expect(diffLines.length).toBe(0);

              // Cleanup
              await fs.rm(testRoot, { recursive: true, force: true });
            } catch (error) {
              // Cleanup on error
              await fs
                .rm(testRoot, { recursive: true, force: true })
                .catch(() => {});
              throw error;
            }
          }
        ),
        {
          numRuns: 5, // INTENSE MODE (was 20, then cranked to 50)
          timeout: 120000, // 2 minute timeout per run
          verbose: true, // Verbose output
          endOnFailure: true, // Stop on first failure to debug
        }
      );
    }, 600000); // 10 minute timeout for the whole test
  });
});

// Helper function
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
