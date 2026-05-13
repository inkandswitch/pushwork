import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as crypto from "crypto";
import * as fc from "fast-check";
import { SnapshotManager } from "../../src/core";

const execFile = promisify(execFileCb);

const CLI_PATH = path.join(__dirname, "../../dist/cli.js");

// The CLI bundle (`dist/cli.js`) is built once by `test/jest.globalSetup.ts`
// before any worker spawns; no per-suite build is needed here.
//
// All integration tests in this file exercise the CLI against the live
// Subduction sync server (`wss://subduction.sync.inkandswitch.com`) via
// the `--sub` flag on `init` and `clone`. `sync` reads the backend choice
// from `.pushwork/config.json` so it has no flag of its own.
//
// We standardize on Subduction here because the previous WebSocket-backed
// fuzzer suite was prone to upstream 502s from `wss://sync3.automerge.org`.
// Property-based fuzz tests in particular need a sync layer that doesn't
// flake on every CI run.
describe("--sub flag integration", () => {
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

  // -------------------- helpers --------------------

  async function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Run pushwork CLI command and return `{ stdout, stderr }`.
   *
   * Throws on non-zero exit code. Retries up to `maxRetries` times on
   * transient sync-server errors (502, 503, ECONNREFUSED, ETIMEDOUT,
   * "unavailable"), with exponential backoff.
   *
   * The per-invocation timeout is generous (50s) because `init --sub` and
   * `sync` against the live Subduction server can be slow under CI load.
   * Each `it()` below also sets its own Jest-level timeout that is larger
   * than this so a stalled command surfaces the underlying CLI output
   * instead of Jest's generic "exceeded timeout" message.
   */
  async function pushwork(
    args: string[],
    cwd?: string,
    maxRetries = 3,
    timeoutMs = 50000,
  ): Promise<{ stdout: string; stderr: string }> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await execFile("node", [CLI_PATH, ...args], {
          cwd,
          timeout: timeoutMs,
          env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        });
      } catch (error: any) {
        lastError = error;
        const errorMessage = (error.message || "") + (error.stderr || "");

        const isTransient =
          errorMessage.includes("502") ||
          errorMessage.includes("503") ||
          errorMessage.includes("ECONNREFUSED") ||
          errorMessage.includes("ETIMEDOUT") ||
          errorMessage.includes("unavailable");

        if (isTransient && attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s, ...
          await wait(Math.pow(2, attempt - 1) * 1000);
          continue;
        }

        throw new Error(
          `pushwork ${args.join(" ")} failed: ${error.message}\n` +
            `stdout: ${error.stdout}\nstderr: ${error.stderr}`,
        );
      }
    }

    throw lastError;
  }

  /**
   * Recursively list all files under a directory, returning relative paths.
   * Skips `.pushwork/` (sync metadata) and any dotfile directory.
   */
  async function getAllFiles(
    dirPath: string,
    basePath: string = dirPath,
  ): Promise<string[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (entry.isDirectory()) {
        files.push(...(await getAllFiles(fullPath, basePath)));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }

    return files;
  }

  /**
   * Compute SHA-256 over a directory's sorted file paths + contents
   * (excluding `.pushwork`). Two directories are considered equivalent
   * iff their hashes match.
   */
  async function hashDirectory(dirPath: string): Promise<string> {
    const files = await getAllFiles(dirPath);
    files.sort();
    const hash = crypto.createHash("sha256");
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      hash.update(file);
      hash.update(await fs.readFile(fullPath));
    }
    return hash.digest("hex");
  }

  async function pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------- single-peer smoke tests --------------------

  describe("init --sub", () => {
    it(
      "should initialize a directory with --sub flag",
      async () => {
        await fs.writeFile(path.join(tmpDir, "hello.txt"), "Hello from sub!");

        await pushwork(["init", "--sub", tmpDir]);

        const pushworkDir = path.join(tmpDir, ".pushwork");
        const stat = await fs.stat(pushworkDir);
        expect(stat.isDirectory()).toBe(true);

        const snapshotManager = new SnapshotManager(tmpDir);
        const snapshot = await snapshotManager.load();
        expect(snapshot).not.toBeNull();
        expect(snapshot!.rootDirectoryUrl).toBeDefined();
        expect(snapshot!.rootDirectoryUrl).toMatch(/^automerge:/);
        expect(snapshot!.files.has("hello.txt")).toBe(true);
      },
      60000,
    );

    it(
      "should track files in subdirectories",
      async () => {
        await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, "src", "index.ts"),
          "export default {}",
        );
        await fs.writeFile(
          path.join(tmpDir, "package.json"),
          '{"name": "test"}',
        );

        await pushwork(["init", "--sub", tmpDir]);

        const snapshotManager = new SnapshotManager(tmpDir);
        const snapshot = await snapshotManager.load();
        expect(snapshot).not.toBeNull();
        expect(snapshot!.files.has("src/index.ts")).toBe(true);
        expect(snapshot!.files.has("package.json")).toBe(true);
      },
      60000,
    );

    it(
      "should respect default exclude patterns with --sub",
      async () => {
        await fs.writeFile(path.join(tmpDir, "included.txt"), "keep me");
        await fs.mkdir(path.join(tmpDir, "node_modules"));
        await fs.writeFile(
          path.join(tmpDir, "node_modules", "dep.js"),
          "module",
        );
        await fs.mkdir(path.join(tmpDir, ".git"));
        await fs.writeFile(
          path.join(tmpDir, ".git", "HEAD"),
          "ref: refs/heads/main",
        );

        await pushwork(["init", "--sub", tmpDir]);

        const snapshotManager = new SnapshotManager(tmpDir);
        const snapshot = await snapshotManager.load();
        expect(snapshot).not.toBeNull();
        expect(snapshot!.files.has("included.txt")).toBe(true);
        expect(snapshot!.files.has("node_modules/dep.js")).toBe(false);
        expect(snapshot!.files.has(".git/HEAD")).toBe(false);
      },
      60000,
    );

    it(
      "should initialize an empty directory",
      async () => {
        await pushwork(["init", "--sub", tmpDir]);

        const snapshotManager = new SnapshotManager(tmpDir);
        const snapshot = await snapshotManager.load();
        expect(snapshot).not.toBeNull();
        expect(snapshot!.rootDirectoryUrl).toBeDefined();
        expect(snapshot!.rootDirectoryUrl).toMatch(/^automerge:/);
        expect(snapshot!.files.size).toBe(0);
      },
      60000,
    );
  });

  describe("sync --sub", () => {
    it(
      "should sync after init --sub",
      async () => {
        await fs.writeFile(path.join(tmpDir, "file1.txt"), "initial content");

        await pushwork(["init", "--sub", tmpDir]);

        await fs.writeFile(path.join(tmpDir, "file2.txt"), "new file");

        // Sync reads the backend choice from .pushwork/config.json (persisted
        // by `init --sub` above); the sync command itself has no --sub flag.
        await pushwork(["sync", tmpDir]);

        const snapshotManager = new SnapshotManager(tmpDir);
        const snapshot = await snapshotManager.load();
        expect(snapshot).not.toBeNull();
        expect(snapshot!.files.has("file1.txt")).toBe(true);
        expect(snapshot!.files.has("file2.txt")).toBe(true);
      },
      60000,
    );

    it(
      "should detect file modifications on sync --sub",
      async () => {
        await fs.writeFile(path.join(tmpDir, "mutable.txt"), "version 1");

        await pushwork(["init", "--sub", tmpDir]);

        const snapshotManager = new SnapshotManager(tmpDir);
        const snapshot1 = await snapshotManager.load();
        const initialHead = snapshot1!.files.get("mutable.txt")!.head;

        await fs.writeFile(path.join(tmpDir, "mutable.txt"), "version 2");

        await pushwork(["sync", tmpDir]);

        const snapshot2 = await snapshotManager.load();
        const updatedHead = snapshot2!.files.get("mutable.txt")!.head;
        expect(updatedHead).not.toEqual(initialHead);
      },
      60000,
    );

    it(
      "should handle file deletions on sync --sub",
      async () => {
        await fs.writeFile(path.join(tmpDir, "ephemeral.txt"), "delete me");
        await fs.writeFile(path.join(tmpDir, "keeper.txt"), "keep me");

        await pushwork(["init", "--sub", tmpDir]);

        await fs.unlink(path.join(tmpDir, "ephemeral.txt"));

        await pushwork(["sync", tmpDir]);

        const snapshotManager = new SnapshotManager(tmpDir);
        const snapshot = await snapshotManager.load();
        expect(snapshot).not.toBeNull();
        expect(snapshot!.files.has("ephemeral.txt")).toBe(false);
        expect(snapshot!.files.has("keeper.txt")).toBe(true);
      },
      60000,
    );
  });

  describe("url after init --sub", () => {
    it(
      "should print a valid automerge URL",
      async () => {
        await pushwork(["init", "--sub", tmpDir]);
        const { stdout } = await pushwork(["url", tmpDir]);
        expect(stdout.trim()).toMatch(/^automerge:/);
      },
      60000,
    );
  });

  describe("status after init --sub", () => {
    it(
      "should report status without errors",
      async () => {
        await fs.writeFile(path.join(tmpDir, "test.txt"), "status check");
        await pushwork(["init", "--sub", tmpDir]);
        const { stdout } = await pushwork(["status", tmpDir]);
        expect(stdout).toBeDefined();
      },
      60000,
    );
  });

  describe("diff after init --sub", () => {
    it(
      "should show no changes immediately after init",
      async () => {
        await fs.writeFile(path.join(tmpDir, "stable.txt"), "no changes");
        await pushwork(["init", "--sub", tmpDir]);
        const { stdout } = await pushwork(["diff", tmpDir]);
        expect(stdout).not.toContain("modified");
      },
      60000,
    );
  });

  // -------------------- two-peer / fuzzer tests --------------------

  describe("Basic Setup and Clone", () => {
    it(
      "should initialize a repo with a single file and clone it successfully",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.writeFile(path.join(repoA, "test.txt"), "Hello, Pushwork!");
        await pushwork(["init", "--sub", "."], repoA);

        await wait(1000);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        const cleanRootUrl = rootUrl.trim();
        expect(cleanRootUrl).toMatch(/^automerge:/);

        await pushwork(["clone", "--sub", cleanRootUrl, repoB], tmpDir);
        await wait(1000);

        expect(await hashDirectory(repoA)).toBe(await hashDirectory(repoB));
        expect(await pathExists(path.join(repoA, "test.txt"))).toBe(true);
        expect(await pathExists(path.join(repoB, "test.txt"))).toBe(true);

        const contentA = await fs.readFile(
          path.join(repoA, "test.txt"),
          "utf-8",
        );
        const contentB = await fs.readFile(
          path.join(repoB, "test.txt"),
          "utf-8",
        );
        expect(contentA).toBe("Hello, Pushwork!");
        expect(contentB).toBe("Hello, Pushwork!");
      },
      60000,
    );
  });

  describe("Manual two-peer scenarios", () => {
    it(
      "should handle a simple edit on one side",
      async () => {
        const repoA = path.join(tmpDir, "manual-a");
        const repoB = path.join(tmpDir, "manual-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.writeFile(path.join(repoA, "test.txt"), "initial content");
        await pushwork(["init", "--sub", "."], repoA);
        await wait(500);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await wait(500);

        await fs.writeFile(path.join(repoA, "test.txt"), "modified content");

        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);
        await pushwork(["sync", "--gentle"], repoB);
        await wait(1000);

        const contentA = await fs.readFile(
          path.join(repoA, "test.txt"),
          "utf-8",
        );
        const contentB = await fs.readFile(
          path.join(repoB, "test.txt"),
          "utf-8",
        );
        expect(contentA).toBe("modified content");
        expect(contentB).toBe("modified content");
      },
      60000,
    );

    it(
      "should handle edit + rename on one side",
      async () => {
        const repoA = path.join(tmpDir, "rename-a");
        const repoB = path.join(tmpDir, "rename-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.writeFile(
          path.join(repoA, "original.txt"),
          "original content",
        );
        await pushwork(["init", "--sub", "."], repoA);
        await wait(500);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await wait(500);

        // Edit AND rename (historically a problem-prone combination).
        await fs.writeFile(path.join(repoA, "original.txt"), "edited content");
        await fs.rename(
          path.join(repoA, "original.txt"),
          path.join(repoA, "renamed.txt"),
        );

        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);
        await pushwork(["sync", "--gentle"], repoB);
        await wait(1000);
        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);
        await pushwork(["sync", "--gentle"], repoB);
        await wait(1000);

        expect(await pathExists(path.join(repoA, "original.txt"))).toBe(false);
        expect(await pathExists(path.join(repoB, "original.txt"))).toBe(false);
        expect(await pathExists(path.join(repoA, "renamed.txt"))).toBe(true);
        expect(await pathExists(path.join(repoB, "renamed.txt"))).toBe(true);

        const contentA = await fs.readFile(
          path.join(repoA, "renamed.txt"),
          "utf-8",
        );
        const contentB = await fs.readFile(
          path.join(repoB, "renamed.txt"),
          "utf-8",
        );
        expect(contentA).toBe("edited content");
        expect(contentB).toBe("edited content");
      },
      120000,
    );

    it(
      "should converge clone-then-add scenario",
      async () => {
        const repoA = path.join(tmpDir, "simple-a");
        const repoB = path.join(tmpDir, "simple-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.writeFile(path.join(repoA, "initial.txt"), "initial");
        await pushwork(["init", "--sub", "."], repoA);
        await wait(1000);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await wait(1000);

        // B creates a new file.
        await fs.writeFile(path.join(repoB, "aaa.txt"), "");

        await pushwork(["sync", "--gentle"], repoB);
        await wait(1000);
        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);

        const filesA = (await fs.readdir(repoA)).filter(
          (f) => !f.startsWith("."),
        );
        const filesB = (await fs.readdir(repoB)).filter(
          (f) => !f.startsWith("."),
        );
        expect(filesA).toEqual(filesB);
        expect(await pathExists(path.join(repoA, "aaa.txt"))).toBe(true);
        expect(await pathExists(path.join(repoB, "aaa.txt"))).toBe(true);
      },
      60000,
    );

    it(
      "should converge files in subdirectories and moves between directories",
      async () => {
        const repoA = path.join(tmpDir, "subdir-a");
        const repoB = path.join(tmpDir, "subdir-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.mkdir(path.join(repoA, "dir1"), { recursive: true });
        await fs.writeFile(path.join(repoA, "dir1", "file1.txt"), "in dir1");

        await pushwork(["init", "--sub", "."], repoA);
        await wait(500);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await wait(500);

        expect(await pathExists(path.join(repoB, "dir1", "file1.txt"))).toBe(
          true,
        );
        expect(
          await fs.readFile(path.join(repoB, "dir1", "file1.txt"), "utf-8"),
        ).toBe("in dir1");

        await fs.mkdir(path.join(repoA, "dir2"), { recursive: true });
        await fs.writeFile(path.join(repoA, "dir2", "file2.txt"), "in dir2");

        await pushwork(["sync", "--gentle"], repoA);
        await wait(1000);
        await pushwork(["sync", "--gentle"], repoB);
        await wait(1000);

        expect(await pathExists(path.join(repoB, "dir2", "file2.txt"))).toBe(
          true,
        );
        expect(
          await fs.readFile(path.join(repoB, "dir2", "file2.txt"), "utf-8"),
        ).toBe("in dir2");
      },
      60000,
    );
  });

  describe("Property-based fuzzing with fast-check", () => {
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

    const dirNameArbitrary = fc.stringMatching(/^[a-z]{2,6}$/);
    const baseNameArbitrary = fc
      .tuple(
        fc.stringMatching(/^[a-z]{3,8}$/),
        fc.constantFrom("txt", "md", "json", "ts"),
      )
      .map(([name, ext]) => `${name}.${ext}`);
    const filePathArbitrary = fc.oneof(
      baseNameArbitrary,
      fc
        .tuple(dirNameArbitrary, baseNameArbitrary)
        .map(([dir, file]) => `${dir}/${file}`),
      fc
        .tuple(dirNameArbitrary, dirNameArbitrary, baseNameArbitrary)
        .map(([d1, d2, file]) => `${d1}/${d2}/${file}`),
    );
    const fileContentArbitrary = fc.string({ minLength: 0, maxLength: 100 });

    const fileOperationArbitrary: fc.Arbitrary<FileOperation> = fc.oneof(
      fc.record({
        type: fc.constant("add" as const),
        path: filePathArbitrary,
        content: fileContentArbitrary,
      }),
      fc.record({
        type: fc.constant("edit" as const),
        path: filePathArbitrary,
        content: fileContentArbitrary,
      }),
      fc.record({
        type: fc.constant("delete" as const),
        path: filePathArbitrary,
      }),
      fc.record({
        type: fc.constant("rename" as const),
        fromPath: filePathArbitrary,
        toPath: filePathArbitrary,
      }),
      fc.record({
        type: fc.constant("editAndRename" as const),
        fromPath: filePathArbitrary,
        toPath: filePathArbitrary,
        content: fileContentArbitrary,
      }),
    );

    async function ensureParentDir(filePath: string): Promise<void> {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
    }

    async function applyOperation(
      repoPath: string,
      op: FileOperation,
    ): Promise<void> {
      try {
        switch (op.type) {
          case "add":
          case "edit": {
            const filePath = path.join(repoPath, op.path);
            await ensureParentDir(filePath);
            await fs.writeFile(filePath, op.content);
            break;
          }
          case "delete": {
            const filePath = path.join(repoPath, op.path);
            if (await pathExists(filePath)) {
              await fs.unlink(filePath);
            }
            break;
          }
          case "rename": {
            const fromPath = path.join(repoPath, op.fromPath);
            const toPath = path.join(repoPath, op.toPath);
            if ((await pathExists(fromPath)) && !(await pathExists(toPath))) {
              await ensureParentDir(toPath);
              await fs.rename(fromPath, toPath);
            }
            break;
          }
          case "editAndRename": {
            const fromPath = path.join(repoPath, op.fromPath);
            const toPath = path.join(repoPath, op.toPath);
            if ((await pathExists(fromPath)) && !(await pathExists(toPath))) {
              await fs.writeFile(fromPath, op.content);
              await ensureParentDir(toPath);
              await fs.rename(fromPath, toPath);
            }
            break;
          }
        }
      } catch {
        // Operations that can't be applied (e.g. delete of non-existent
        // file) are expected during fuzzing — they're effectively no-ops.
      }
    }

    async function applyOperations(
      repoPath: string,
      operations: FileOperation[],
    ): Promise<void> {
      for (const op of operations) {
        await applyOperation(repoPath, op);
      }
    }

    it(
      "should converge after random operations on both sides",
      async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(fileOperationArbitrary, { minLength: 1, maxLength: 10 }),
            fc.array(fileOperationArbitrary, { minLength: 1, maxLength: 10 }),
            async (opsA, opsB) => {
              const testRoot = path.join(
                tmpDir,
                `prop-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
              );
              await fs.mkdir(testRoot, { recursive: true });
              const repoA = path.join(testRoot, "repo-a");
              const repoB = path.join(testRoot, "repo-b");
              await fs.mkdir(repoA);
              await fs.mkdir(repoB);

              try {
                await fs.writeFile(
                  path.join(repoA, "initial.txt"),
                  "initial",
                );
                await pushwork(["init", "--sub", "."], repoA);
                await wait(2000);

                const { stdout: rootUrl } = await pushwork(["url"], repoA);
                await pushwork(
                  ["clone", "--sub", rootUrl.trim(), repoB],
                  testRoot,
                  5,
                );
                await wait(1000);

                // Sanity-check that the initial clone converged before
                // running random operations, so a failure later is
                // clearly attributable to the ops rather than to clone.
                const hashBefore = await hashDirectory(repoA);
                const hashBcheck = await hashDirectory(repoB);
                if (hashBefore !== hashBcheck) {
                  throw new Error(
                    `Initial clone hash mismatch:\n` +
                      `  repoA hash: ${hashBefore}\n` +
                      `  repoB hash: ${hashBcheck}\n` +
                      `  repoA files: ${JSON.stringify(await getAllFiles(repoA))}\n` +
                      `  repoB files: ${JSON.stringify(await getAllFiles(repoB))}`,
                  );
                }

                await applyOperations(repoA, opsA);
                await applyOperations(repoB, opsB);

                // Multiple sync rounds to let both sides observe each
                // other's changes. The pattern is A push, B push+pull,
                // A pull, B confirm, A final, B final.
                for (const repo of [repoA, repoB, repoA, repoB, repoA, repoB]) {
                  await pushwork(["sync", "--gentle"], repo);
                  await wait(1000);
                }
                await wait(2000);

                expect(await hashDirectory(repoA)).toBe(
                  await hashDirectory(repoB),
                );

                const { stdout: diffOutput } = await pushwork(
                  ["diff", "--name-only"],
                  repoA,
                );
                const diffLines = diffOutput
                  .split("\n")
                  .filter(
                    (line) =>
                      line.trim() &&
                      !line.includes("✓") &&
                      !line.includes("Local-only") &&
                      !line.includes("Root URL"),
                  );
                expect(diffLines.length).toBe(0);
              } finally {
                await fs
                  .rm(testRoot, { recursive: true, force: true })
                  .catch(() => undefined);
              }
            },
          ),
          {
            // Each run takes ~30-60s against the live sync server; 3
            // gives reasonable coverage without ballooning CI time.
            numRuns: 3,
            timeout: 120000,
            endOnFailure: true,
          },
        );
      },
      600000,
    );
  });

  // -------------------- sync reliability (convergence-based) --------------------

  /**
   * Sync both repos in alternation until their filesystem hashes match,
   * or until `maxRounds` is reached. Returns the round count on success
   * so tests can assert quick convergence.
   *
   * This is the convergence-based alternative to fixed `wait()` delays
   * used in the manual two-peer scenarios above. Each round costs two
   * `sync --gentle` calls, so keep `maxRounds` modest when the per-test
   * timeout is 30 s.
   */
  async function syncUntilConverged(
    repoA: string,
    repoB: string,
    options: { maxRounds?: number; timeoutMs?: number } = {},
  ): Promise<{ rounds: number; hashA: string; hashB: string }> {
    const { maxRounds = 5, timeoutMs = 30000 } = options;
    const startTime = Date.now();

    for (let round = 1; round <= maxRounds; round++) {
      if (Date.now() - startTime > timeoutMs) {
        const hashA = await hashDirectory(repoA);
        const hashB = await hashDirectory(repoB);
        throw new Error(
          `Sync timeout after ${round - 1} rounds and ${Date.now() - startTime}ms. ` +
            `hashA=${hashA.slice(0, 8)}, hashB=${hashB.slice(0, 8)}`,
        );
      }

      await pushwork(["sync", "--gentle"], repoA);
      await pushwork(["sync", "--gentle"], repoB);

      const hashA = await hashDirectory(repoA);
      const hashB = await hashDirectory(repoB);
      if (hashA === hashB) return { rounds: round, hashA, hashB };
    }

    const hashA = await hashDirectory(repoA);
    const hashB = await hashDirectory(repoB);
    throw new Error(
      `Failed to converge after ${maxRounds} sync rounds. ` +
        `hashA=${hashA.slice(0, 8)}, hashB=${hashB.slice(0, 8)}`,
    );
  }

  describe("Basic Two-Repo Sync", () => {
    it(
      "should have matching state immediately after clone (strict)",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.writeFile(path.join(repoA, "test.txt"), "Hello from A");
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);

        // STRICT: check immediately, no extra sync rounds.
        expect(await hashDirectory(repoA)).toBe(await hashDirectory(repoB));
        expect(await pathExists(path.join(repoA, "test.txt"))).toBe(true);
        expect(await pathExists(path.join(repoB, "test.txt"))).toBe(true);
        expect(
          await fs.readFile(path.join(repoA, "test.txt"), "utf-8"),
        ).toBe("Hello from A");
        expect(
          await fs.readFile(path.join(repoB, "test.txt"), "utf-8"),
        ).toBe("Hello from A");
      },
      30000,
    );

    it(
      "should sync a file from A to B (with convergence)",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.writeFile(path.join(repoA, "test.txt"), "Hello from A");
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);

        const { rounds, hashA, hashB } = await syncUntilConverged(repoA, repoB);
        expect(hashA).toBe(hashB);
        expect(rounds).toBeLessThanOrEqual(2);
        expect(
          await fs.readFile(path.join(repoA, "test.txt"), "utf-8"),
        ).toBe("Hello from A");
        expect(
          await fs.readFile(path.join(repoB, "test.txt"), "utf-8"),
        ).toBe("Hello from A");
      },
      30000,
    );

    it(
      "should sync a new file added to B back to A",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.writeFile(path.join(repoA, "initial.txt"), "initial");
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await syncUntilConverged(repoA, repoB);

        await fs.writeFile(path.join(repoB, "from-b.txt"), "Created by B");

        const { rounds } = await syncUntilConverged(repoA, repoB);
        expect(rounds).toBeLessThanOrEqual(3);
        expect(await pathExists(path.join(repoA, "from-b.txt"))).toBe(true);
        expect(
          await fs.readFile(path.join(repoA, "from-b.txt"), "utf-8"),
        ).toBe("Created by B");
      },
      30000,
    );

    it(
      "should sync subdirectories correctly",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.mkdir(path.join(repoA, "subdir"), { recursive: true });
        await fs.writeFile(
          path.join(repoA, "subdir", "nested.txt"),
          "Nested content",
        );
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        const { rounds } = await syncUntilConverged(repoA, repoB);

        expect(rounds).toBeLessThanOrEqual(2);
        expect(
          await pathExists(path.join(repoB, "subdir", "nested.txt")),
        ).toBe(true);
        expect(
          await fs.readFile(path.join(repoB, "subdir", "nested.txt"), "utf-8"),
        ).toBe("Nested content");
      },
      30000,
    );
  });

  describe("Concurrent Operations", () => {
    it(
      "should handle concurrent file creation on both sides",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.writeFile(path.join(repoA, "initial.txt"), "initial");
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await syncUntilConverged(repoA, repoB);

        await fs.writeFile(path.join(repoA, "file-a.txt"), "From A");
        await fs.writeFile(path.join(repoB, "file-b.txt"), "From B");

        const { rounds } = await syncUntilConverged(repoA, repoB);
        expect(rounds).toBeLessThanOrEqual(3);

        expect(await pathExists(path.join(repoA, "file-a.txt"))).toBe(true);
        expect(await pathExists(path.join(repoA, "file-b.txt"))).toBe(true);
        expect(await pathExists(path.join(repoB, "file-a.txt"))).toBe(true);
        expect(await pathExists(path.join(repoB, "file-b.txt"))).toBe(true);
      },
      30000,
    );

    it(
      "should handle file modification sync",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.writeFile(path.join(repoA, "shared.txt"), "Original");
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await syncUntilConverged(repoA, repoB);

        await fs.writeFile(path.join(repoA, "shared.txt"), "Modified by A");

        const { rounds } = await syncUntilConverged(repoA, repoB);
        expect(rounds).toBeLessThanOrEqual(3);
        expect(
          await fs.readFile(path.join(repoB, "shared.txt"), "utf-8"),
        ).toBe("Modified by A");
      },
      30000,
    );

    it(
      "should handle file deletion sync",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.writeFile(
          path.join(repoA, "to-delete.txt"),
          "Will be deleted",
        );
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await syncUntilConverged(repoA, repoB);

        expect(await pathExists(path.join(repoB, "to-delete.txt"))).toBe(true);

        await fs.unlink(path.join(repoA, "to-delete.txt"));

        const { rounds } = await syncUntilConverged(repoA, repoB);
        expect(rounds).toBeLessThanOrEqual(3);
        expect(await pathExists(path.join(repoB, "to-delete.txt"))).toBe(false);
      },
      30000,
    );
  });

  describe("Subdirectory File Deletion - Resurrection Bug", () => {
    // Single-peer regression tests for the artifact-deletion resurrection
    // bug. The fix lives in `applyRemoteChangeToLocal` (sync-engine.ts):
    // artifact files pulled from a peer must record a `contentHash` so
    // the next sync doesn't misinterpret them as locally modified.

    it(
      "deleted file in artifact directory should not resurrect",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        await fs.mkdir(repoA);

        await fs.mkdir(path.join(repoA, "dist", "assets"), { recursive: true });
        await fs.writeFile(
          path.join(repoA, "dist", "assets", "app.js"),
          "// build 1",
        );
        await pushwork(["init", "--sub", "."], repoA);
        await pushwork(["sync"], repoA);

        await fs.unlink(path.join(repoA, "dist", "assets", "app.js"));

        await pushwork(["sync"], repoA);
        expect(
          await pathExists(path.join(repoA, "dist", "assets", "app.js")),
        ).toBe(false);

        await pushwork(["sync"], repoA);
        expect(
          await pathExists(path.join(repoA, "dist", "assets", "app.js")),
        ).toBe(false);
      },
      60000,
    );

    it(
      "deleted file in depth-1 subdirectory should not resurrect (control)",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        await fs.mkdir(repoA);

        await fs.mkdir(path.join(repoA, "subdir"), { recursive: true });
        await fs.writeFile(
          path.join(repoA, "subdir", "file.txt"),
          "content",
        );
        await pushwork(["init", "--sub", "."], repoA);
        await pushwork(["sync"], repoA);

        await fs.unlink(path.join(repoA, "subdir", "file.txt"));

        await pushwork(["sync"], repoA);
        expect(
          await pathExists(path.join(repoA, "subdir", "file.txt")),
        ).toBe(false);

        await pushwork(["sync"], repoA);
        expect(
          await pathExists(path.join(repoA, "subdir", "file.txt")),
        ).toBe(false);
      },
      60000,
    );

    it(
      "deleted build artifacts should not resurrect after rebuild cycle",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        await fs.mkdir(repoA);

        await fs.mkdir(path.join(repoA, "dist", "assets"), { recursive: true });
        await fs.writeFile(
          path.join(repoA, "dist", "assets", "app-ABC123.js"),
          "// build 1",
        );
        await fs.writeFile(
          path.join(repoA, "dist", "assets", "vendor-DEF456.js"),
          "// vendor 1",
        );
        await fs.writeFile(
          path.join(repoA, "dist", "index.js"),
          "// index 1",
        );
        await pushwork(["init", "--sub", "."], repoA);
        await pushwork(["sync"], repoA);

        await fs.unlink(path.join(repoA, "dist", "assets", "app-ABC123.js"));
        await fs.unlink(
          path.join(repoA, "dist", "assets", "vendor-DEF456.js"),
        );
        await fs.writeFile(
          path.join(repoA, "dist", "assets", "app-XYZ789.js"),
          "// build 2",
        );
        await fs.writeFile(
          path.join(repoA, "dist", "assets", "vendor-UVW012.js"),
          "// vendor 2",
        );
        await fs.writeFile(
          path.join(repoA, "dist", "index.js"),
          "// index 2",
        );

        await pushwork(["sync"], repoA);

        expect(
          await pathExists(path.join(repoA, "dist", "assets", "app-ABC123.js")),
        ).toBe(false);
        expect(
          await pathExists(
            path.join(repoA, "dist", "assets", "vendor-DEF456.js"),
          ),
        ).toBe(false);
        expect(
          await pathExists(path.join(repoA, "dist", "assets", "app-XYZ789.js")),
        ).toBe(true);
        expect(
          await pathExists(
            path.join(repoA, "dist", "assets", "vendor-UVW012.js"),
          ),
        ).toBe(true);

        await pushwork(["sync"], repoA);

        expect(
          await pathExists(path.join(repoA, "dist", "assets", "app-ABC123.js")),
        ).toBe(false);
        expect(
          await pathExists(
            path.join(repoA, "dist", "assets", "vendor-DEF456.js"),
          ),
        ).toBe(false);
      },
      60000,
    );

    it(
      "deleted artifact files should not resurrect on clone",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.mkdir(path.join(repoA, "dist", "assets"), { recursive: true });
        await fs.writeFile(
          path.join(repoA, "dist", "assets", "app-ABC123.js"),
          "// build 1",
        );
        await fs.writeFile(
          path.join(repoA, "dist", "assets", "vendor-DEF456.js"),
          "// vendor 1",
        );
        await fs.writeFile(
          path.join(repoA, "dist", "index.js"),
          "// index 1",
        );
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await syncUntilConverged(repoA, repoB);

        expect(
          await pathExists(path.join(repoB, "dist", "assets", "app-ABC123.js")),
        ).toBe(true);

        // A rebuilds.
        await fs.unlink(path.join(repoA, "dist", "assets", "app-ABC123.js"));
        await fs.unlink(
          path.join(repoA, "dist", "assets", "vendor-DEF456.js"),
        );
        await fs.writeFile(
          path.join(repoA, "dist", "assets", "app-XYZ789.js"),
          "// build 2",
        );
        await fs.writeFile(
          path.join(repoA, "dist", "assets", "vendor-UVW012.js"),
          "// vendor 2",
        );
        await fs.writeFile(
          path.join(repoA, "dist", "index.js"),
          "// index 2",
        );

        await pushwork(["sync"], repoA);

        expect(
          await pathExists(path.join(repoA, "dist", "assets", "app-ABC123.js")),
        ).toBe(false);
        expect(
          await pathExists(
            path.join(repoA, "dist", "assets", "vendor-DEF456.js"),
          ),
        ).toBe(false);

        await pushwork(["sync"], repoB);

        expect(
          await pathExists(path.join(repoB, "dist", "assets", "app-ABC123.js")),
        ).toBe(false);
        expect(
          await pathExists(
            path.join(repoB, "dist", "assets", "vendor-DEF456.js"),
          ),
        ).toBe(false);
        expect(
          await pathExists(path.join(repoB, "dist", "assets", "app-XYZ789.js")),
        ).toBe(true);
      },
      90000,
    );

    it(
      "deleted file in depth-3 subdirectory should not resurrect",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        await fs.mkdir(repoA);

        await fs.mkdir(path.join(repoA, "a", "b", "c"), { recursive: true });
        await fs.writeFile(
          path.join(repoA, "a", "b", "c", "deep.txt"),
          "deep",
        );
        await pushwork(["init", "--sub", "."], repoA);
        await pushwork(["sync"], repoA);

        await fs.unlink(path.join(repoA, "a", "b", "c", "deep.txt"));

        await pushwork(["sync"], repoA);
        expect(
          await pathExists(path.join(repoA, "a", "b", "c", "deep.txt")),
        ).toBe(false);

        await pushwork(["sync"], repoA);
        expect(
          await pathExists(path.join(repoA, "a", "b", "c", "deep.txt")),
        ).toBe(false);
      },
      60000,
    );

    it(
      "create+delete in same subdirectory should not resurrect deleted files",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        await fs.mkdir(repoA);

        await fs.mkdir(path.join(repoA, "subdir"), { recursive: true });
        await fs.writeFile(
          path.join(repoA, "subdir", "old.txt"),
          "old content",
        );
        await pushwork(["init", "--sub", "."], repoA);
        await pushwork(["sync"], repoA);

        await fs.unlink(path.join(repoA, "subdir", "old.txt"));
        await fs.writeFile(
          path.join(repoA, "subdir", "new.txt"),
          "new content",
        );

        await pushwork(["sync"], repoA);

        expect(
          await pathExists(path.join(repoA, "subdir", "old.txt")),
        ).toBe(false);
        expect(
          await pathExists(path.join(repoA, "subdir", "new.txt")),
        ).toBe(true);

        await pushwork(["sync"], repoA);

        expect(
          await pathExists(path.join(repoA, "subdir", "old.txt")),
        ).toBe(false);
        expect(
          await pathExists(path.join(repoA, "subdir", "new.txt")),
        ).toBe(true);
      },
      60000,
    );

    it(
      "deleted file in depth-2 with sibling dirs should not resurrect",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        await fs.mkdir(repoA);

        await fs.mkdir(path.join(repoA, "parent", "child"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(repoA, "parent", "sibling.txt"),
          "sibling at parent level",
        );
        await fs.writeFile(
          path.join(repoA, "parent", "child", "target.txt"),
          "will be deleted",
        );
        await pushwork(["init", "--sub", "."], repoA);
        await pushwork(["sync"], repoA);

        await fs.unlink(path.join(repoA, "parent", "child", "target.txt"));

        await pushwork(["sync"], repoA);
        expect(
          await pathExists(path.join(repoA, "parent", "child", "target.txt")),
        ).toBe(false);
        expect(
          await pathExists(path.join(repoA, "parent", "sibling.txt")),
        ).toBe(true);

        await pushwork(["sync"], repoA);
        expect(
          await pathExists(path.join(repoA, "parent", "child", "target.txt")),
        ).toBe(false);
      },
      60000,
    );

    it(
      "deleted file in root directory should not resurrect",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        await fs.mkdir(repoA);

        await fs.writeFile(path.join(repoA, "root-file.txt"), "root content");
        await fs.writeFile(path.join(repoA, "keep.txt"), "keep this");
        await pushwork(["init", "--sub", "."], repoA);
        await pushwork(["sync"], repoA);

        await fs.unlink(path.join(repoA, "root-file.txt"));

        await pushwork(["sync"], repoA);
        expect(await pathExists(path.join(repoA, "root-file.txt"))).toBe(
          false,
        );
        expect(await pathExists(path.join(repoA, "keep.txt"))).toBe(true);

        await pushwork(["sync"], repoA);
        expect(await pathExists(path.join(repoA, "root-file.txt"))).toBe(
          false,
        );
      },
      60000,
    );

    it(
      "deleted file in non-artifact subdirectory (src/) should not resurrect",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        await fs.mkdir(repoA);

        await fs.mkdir(path.join(repoA, "src"), { recursive: true });
        await fs.writeFile(
          path.join(repoA, "src", "index.ts"),
          "export default 1",
        );
        await fs.writeFile(
          path.join(repoA, "src", "helper.ts"),
          "export function help() {}",
        );
        await pushwork(["init", "--sub", "."], repoA);
        await pushwork(["sync"], repoA);

        await fs.unlink(path.join(repoA, "src", "helper.ts"));

        await pushwork(["sync"], repoA);
        expect(await pathExists(path.join(repoA, "src", "helper.ts"))).toBe(
          false,
        );
        expect(await pathExists(path.join(repoA, "src", "index.ts"))).toBe(
          true,
        );

        await pushwork(["sync"], repoA);
        expect(await pathExists(path.join(repoA, "src", "helper.ts"))).toBe(
          false,
        );
      },
      60000,
    );

    it(
      "deleted files should not resurrect after multiple sync cycles",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        await fs.mkdir(repoA);

        await fs.mkdir(path.join(repoA, "src"), { recursive: true });
        await fs.writeFile(path.join(repoA, "readme.txt"), "readme");
        await fs.writeFile(path.join(repoA, "src", "app.ts"), "app");
        await fs.writeFile(path.join(repoA, "src", "old.ts"), "old");
        await pushwork(["init", "--sub", "."], repoA);
        await pushwork(["sync"], repoA);

        // Cycle 1: delete root file.
        await fs.unlink(path.join(repoA, "readme.txt"));
        await pushwork(["sync"], repoA);
        expect(await pathExists(path.join(repoA, "readme.txt"))).toBe(false);

        // Cycle 2: delete src file.
        await fs.unlink(path.join(repoA, "src", "old.ts"));
        await pushwork(["sync"], repoA);
        expect(await pathExists(path.join(repoA, "src", "old.ts"))).toBe(
          false,
        );

        // Cycle 3: just sync — nothing should come back.
        await pushwork(["sync"], repoA);
        expect(await pathExists(path.join(repoA, "readme.txt"))).toBe(false);
        expect(await pathExists(path.join(repoA, "src", "old.ts"))).toBe(
          false,
        );
        expect(await pathExists(path.join(repoA, "src", "app.ts"))).toBe(true);
      },
      90000,
    );

    it(
      "peer B should not see files deleted by peer A (root)",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.writeFile(path.join(repoA, "keep.txt"), "keep");
        await fs.writeFile(path.join(repoA, "delete-me.txt"), "gone");
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await syncUntilConverged(repoA, repoB);

        expect(await pathExists(path.join(repoB, "delete-me.txt"))).toBe(true);

        await fs.unlink(path.join(repoA, "delete-me.txt"));
        await pushwork(["sync"], repoA);

        await pushwork(["sync"], repoB);
        expect(await pathExists(path.join(repoB, "delete-me.txt"))).toBe(
          false,
        );
        expect(await pathExists(path.join(repoB, "keep.txt"))).toBe(true);

        await pushwork(["sync"], repoB);
        expect(await pathExists(path.join(repoB, "delete-me.txt"))).toBe(
          false,
        );
      },
      90000,
    );

    it(
      "peer B should not see files deleted by peer A (src/)",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.mkdir(path.join(repoA, "src"), { recursive: true });
        await fs.writeFile(
          path.join(repoA, "src", "index.ts"),
          "export default 1",
        );
        await fs.writeFile(
          path.join(repoA, "src", "old.ts"),
          "old code",
        );
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await syncUntilConverged(repoA, repoB);

        expect(await pathExists(path.join(repoB, "src", "old.ts"))).toBe(true);

        await fs.unlink(path.join(repoA, "src", "old.ts"));
        await pushwork(["sync"], repoA);

        await pushwork(["sync"], repoB);
        expect(await pathExists(path.join(repoB, "src", "old.ts"))).toBe(
          false,
        );
        expect(await pathExists(path.join(repoB, "src", "index.ts"))).toBe(
          true,
        );

        await pushwork(["sync"], repoB);
        expect(await pathExists(path.join(repoB, "src", "old.ts"))).toBe(
          false,
        );
      },
      90000,
    );

    it(
      "peer B should not see files deleted by peer A (dist/)",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.mkdir(path.join(repoA, "dist", "assets"), { recursive: true });
        await fs.writeFile(path.join(repoA, "dist", "index.js"), "// index");
        await fs.writeFile(
          path.join(repoA, "dist", "assets", "app-ABC.js"),
          "// build 1",
        );
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await syncUntilConverged(repoA, repoB);

        expect(
          await pathExists(path.join(repoB, "dist", "assets", "app-ABC.js")),
        ).toBe(true);

        // A rebuilds: delete old artifact, create new one.
        await fs.unlink(path.join(repoA, "dist", "assets", "app-ABC.js"));
        await fs.writeFile(
          path.join(repoA, "dist", "assets", "app-XYZ.js"),
          "// build 2",
        );
        await pushwork(["sync"], repoA);

        expect(
          await pathExists(path.join(repoA, "dist", "assets", "app-ABC.js")),
        ).toBe(false);

        await pushwork(["sync"], repoB);
        expect(
          await pathExists(path.join(repoB, "dist", "assets", "app-ABC.js")),
        ).toBe(false);
        expect(
          await pathExists(path.join(repoB, "dist", "assets", "app-XYZ.js")),
        ).toBe(true);

        await pushwork(["sync"], repoB);
        expect(
          await pathExists(path.join(repoB, "dist", "assets", "app-ABC.js")),
        ).toBe(false);
      },
      90000,
    );

    it(
      "peer B should see artifact file content update after URL replacement",
      async () => {
        // When peer A modifies an artifact file, the document is replaced
        // entirely (new Automerge doc URL). B's snapshot still points at
        // the old (now orphaned) URL. detectRemoteChanges sees no head
        // change on the old doc; detectNewRemoteDocuments skips paths
        // already in the snapshot. Without the URL-replacement detection
        // in `detectNewRemoteDocuments` B would never see the update.
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        await fs.mkdir(path.join(repoA, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(repoA, "dist", "app.js"),
          "// version 1",
        );
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await syncUntilConverged(repoA, repoB);

        expect(
          await fs.readFile(path.join(repoB, "dist", "app.js"), "utf-8"),
        ).toBe("// version 1");

        // A modifies the artifact file — this triggers nuclear replacement.
        await fs.writeFile(
          path.join(repoA, "dist", "app.js"),
          "// version 2",
        );
        await pushwork(["sync"], repoA);

        await pushwork(["sync"], repoB);
        expect(
          await fs.readFile(path.join(repoB, "dist", "app.js"), "utf-8"),
        ).toBe("// version 2");
      },
      90000,
    );
  });

  describe("Move/Rename Detection", () => {
    it(
      "should handle file rename",
      async () => {
        const repoA = path.join(tmpDir, "repo-a");
        const repoB = path.join(tmpDir, "repo-b");
        await fs.mkdir(repoA);
        await fs.mkdir(repoB);

        const content =
          "This content will be used for similarity detection during move";
        await fs.writeFile(path.join(repoA, "original.txt"), content);
        await pushwork(["init", "--sub", "."], repoA);

        const { stdout: rootUrl } = await pushwork(["url"], repoA);
        await pushwork(["clone", "--sub", rootUrl.trim(), repoB], tmpDir);
        await syncUntilConverged(repoA, repoB);

        await fs.rename(
          path.join(repoA, "original.txt"),
          path.join(repoA, "renamed.txt"),
        );

        const { rounds } = await syncUntilConverged(repoA, repoB);
        expect(rounds).toBeLessThanOrEqual(3);

        expect(await pathExists(path.join(repoA, "original.txt"))).toBe(false);
        expect(await pathExists(path.join(repoA, "renamed.txt"))).toBe(true);
        expect(await pathExists(path.join(repoB, "original.txt"))).toBe(false);
        expect(await pathExists(path.join(repoB, "renamed.txt"))).toBe(true);

        expect(
          await fs.readFile(path.join(repoB, "renamed.txt"), "utf-8"),
        ).toBe(content);
      },
      30000,
    );
  });
});
