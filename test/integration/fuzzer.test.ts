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
   * Helper: Execute pushwork CLI command
   */
  async function pushwork(
    args: string[],
    cwd: string
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFilePromise("node", [PUSHWORK_CLI, ...args], {
        cwd,
        env: { ...process.env, FORCE_COLOR: "0" }, // Disable color codes for cleaner output
      });
      return result;
    } catch (error: any) {
      // execFile throws on non-zero exit code, but we still want stdout/stderr
      throw new Error(
        `pushwork ${args.join(" ")} failed: ${error.message}\nstdout: ${
          error.stdout
        }\nstderr: ${error.stderr}`
      );
    }
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

  /**
   * Helper: Wait for a short time (useful for allowing sync to complete)
   */
  async function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  describe("Basic Setup and Clone", () => {
    it("should initialize a repo with a single file and clone it successfully", async () => {
      // Create two directories for testing
      const repoA = path.join(tmpDir, "repo-a");
      const repoB = path.join(tmpDir, "repo-b");
      await fs.mkdir(repoA);
      await fs.mkdir(repoB);

      console.log(`Test directories created:`);
      console.log(`  Repo A: ${repoA}`);
      console.log(`  Repo B: ${repoB}`);

      // Step 1: Create a file in repo A
      const testFile = path.join(repoA, "test.txt");
      await fs.writeFile(testFile, "Hello, Pushwork!");
      console.log(`Created test file: ${testFile}`);

      // Step 2: Initialize repo A
      console.log(`Initializing repo A...`);
      await pushwork(["init", "."], repoA);
      console.log(`Repo A initialized successfully`);

      // Wait a moment for initialization to complete
      await wait(1000);

      // Step 3: Get the root URL from repo A
      console.log(`Getting root URL from repo A...`);
      const { stdout: rootUrl } = await pushwork(["url"], repoA);
      const cleanRootUrl = rootUrl.trim();
      console.log(`Root URL: ${cleanRootUrl}`);

      expect(cleanRootUrl).toMatch(/^automerge:/);

      // Step 4: Clone repo A to repo B
      console.log(`Cloning repo A to repo B...`);
      await pushwork(["clone", cleanRootUrl, repoB], tmpDir);
      console.log(`Repo B cloned successfully`);

      // Wait a moment for clone to complete
      await wait(1000);

      // Step 5: Verify both repos have the same content
      console.log(`Computing hashes...`);
      const hashA = await hashDirectory(repoA);
      const hashB = await hashDirectory(repoB);

      console.log(`Hash A: ${hashA}`);
      console.log(`Hash B: ${hashB}`);

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

      console.log(`✅ Test passed! Both repos are identical.`);
    }, 30000); // 30 second timeout for this test
  });

  describe("Manual Fuzzing Tests", () => {
    it("should handle a simple edit on one side", async () => {
      const repoA = path.join(tmpDir, "manual-a");
      const repoB = path.join(tmpDir, "manual-b");
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
      await pushwork(["sync"], repoA);
      await wait(1000);

      // Sync B to pull changes
      await pushwork(["sync"], repoB);
      await wait(1000);

      // Verify they match
      const contentA = await fs.readFile(path.join(repoA, "test.txt"), "utf-8");
      const contentB = await fs.readFile(path.join(repoB, "test.txt"), "utf-8");

      expect(contentA).toBe("modified content");
      expect(contentB).toBe("modified content");
    }, 30000);
  });

  describe("Property-Based Fuzzing with fast-check", () => {
    // Define operation types
    type FileOperation =
      | { type: "add"; path: string; content: string }
      | { type: "edit"; path: string; content: string }
      | { type: "delete"; path: string };

    /**
     * Arbitrary: Generate a simple filename (no subdirectories for now)
     */
    const fileNameArbitrary = fc
      .tuple(
        fc.stringMatching(/^[a-z]{3,8}$/), // basename
        fc.constantFrom("txt", "md", "json", "ts") // extension
      )
      .map(([name, ext]) => `${name}.${ext}`);

    /**
     * Arbitrary: Generate file content (small strings for now)
     */
    const fileContentArbitrary = fc.string({ minLength: 0, maxLength: 100 });

    /**
     * Arbitrary: Generate a file operation
     */
    const fileOperationArbitrary: fc.Arbitrary<FileOperation> = fc.oneof(
      // Add file
      fc.record({
        type: fc.constant("add" as const),
        path: fileNameArbitrary,
        content: fileContentArbitrary,
      }),
      // Edit file
      fc.record({
        type: fc.constant("edit" as const),
        path: fileNameArbitrary,
        content: fileContentArbitrary,
      }),
      // Delete file
      fc.record({
        type: fc.constant("delete" as const),
        path: fileNameArbitrary,
      })
    );

    /**
     * Helper: Apply a file operation to a directory
     */
    async function applyOperation(
      repoPath: string,
      op: FileOperation
    ): Promise<void> {
      const filePath = path.join(repoPath, op.path);

      try {
        switch (op.type) {
          case "add":
            await fs.writeFile(filePath, op.content);
            break;
          case "edit":
            // Only edit if file exists, otherwise create it
            if (await pathExists(filePath)) {
              await fs.writeFile(filePath, op.content);
            } else {
              await fs.writeFile(filePath, op.content);
            }
            break;
          case "delete":
            // Only delete if file exists
            if (await pathExists(filePath)) {
              await fs.unlink(filePath);
            }
            break;
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
          fc.array(fileOperationArbitrary, { minLength: 1, maxLength: 1 }), // Operations on repo A
          fc.array(fileOperationArbitrary, { minLength: 1, maxLength: 1 }), // Operations on repo B
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

            console.log(
              `\n🔬 Testing with ${opsA.length} ops on A, ${opsB.length} ops on B`
            );

            try {
              // Initialize repo A with an initial file
              await fs.writeFile(path.join(repoA, "initial.txt"), "initial");
              await pushwork(["init", "."], repoA);
              await wait(500);

              // Get root URL and clone to B
              const { stdout: rootUrl } = await pushwork(["url"], repoA);
              const cleanRootUrl = rootUrl.trim();
              await pushwork(["clone", cleanRootUrl, repoB], testRoot);
              await wait(500);

              // Verify initial state matches
              const hashBeforeOps = await hashDirectory(repoA);
              const hashB1 = await hashDirectory(repoB);
              expect(hashBeforeOps).toBe(hashB1);

              // Apply operations to both sides
              console.log(`  Applying ${opsA.length} operations to repo A...`);
              await applyOperations(repoA, opsA);

              console.log(`  Applying ${opsB.length} operations to repo B...`);
              await applyOperations(repoB, opsB);

              // Sync from A
              console.log(`  Syncing repo A...`);
              await pushwork(["sync"], repoA);
              await wait(1000);

              // Sync from B
              console.log(`  Syncing repo B...`);
              await pushwork(["sync"], repoB);
              await wait(1000);

              // One more round to ensure full convergence when both sides changed
              console.log(`  Final convergence sync...`);
              await pushwork(["sync"], repoA);
              await wait(1000);
              await pushwork(["sync"], repoB);
              await wait(1000);

              // Verify final state matches
              console.log(`  Verifying convergence...`);
              const hashAfterA = await hashDirectory(repoA);
              const hashAfterB = await hashDirectory(repoB);

              console.log(`  Hash A: ${hashAfterA.substring(0, 16)}...`);
              console.log(`  Hash B: ${hashAfterB.substring(0, 16)}...`);

              // Both sides should converge to the same state
              if (hashAfterA !== hashAfterB) {
                // Show what files are different
                const filesA = await getAllFiles(repoA);
                const filesB = await getAllFiles(repoB);
                console.log(`  ❌ CONVERGENCE FAILURE!`);
                console.log(
                  `  Files in A: ${filesA
                    .filter((f) => !f.includes(".pushwork"))
                    .join(", ")}`
                );
                console.log(
                  `  Files in B: ${filesB
                    .filter((f) => !f.includes(".pushwork"))
                    .join(", ")}`
                );
                console.log(
                  `  Operations applied to A: ${JSON.stringify(opsA)}`
                );
                console.log(
                  `  Operations applied to B: ${JSON.stringify(opsB)}`
                );
              }
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

              console.log(`  ✅ Converged successfully!`);

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
          numRuns: 1, // Just 1 run for now
          timeout: 40000, // 40 second timeout per run
          verbose: true,
          endOnFailure: true, // Stop on first failure
        }
      );
    }, 50000); // 50 second timeout for the whole test
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
