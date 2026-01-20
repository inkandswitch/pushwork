import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execSync } from "child_process";
import { SnapshotManager } from "../../src/core";

describe("Init Command Integration", () => {
  let tmpDir: string;
  let cleanup: () => void;
  const pushworkCmd = `node "${path.join(__dirname, "../../dist/cli.js")}"`;

  beforeAll(() => {
    // Build the project before running tests
    execSync("pnpm build", { cwd: path.join(__dirname, "../.."), stdio: "pipe" });
  });

  beforeEach(() => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(async () => {
    cleanup();
  });

  describe("Initial Sync", () => {
    it("should sync existing files during init", async () => {
      // Create some files before initializing
      await fs.writeFile(path.join(tmpDir, "file1.txt"), "Hello, World!");
      await fs.writeFile(path.join(tmpDir, "file2.txt"), "Another file");
      await fs.mkdir(path.join(tmpDir, "subdir"));
      await fs.writeFile(
        path.join(tmpDir, "subdir", "nested.txt"),
        "Nested content"
      );

      // Run pushwork init
      execSync(`${pushworkCmd} init "${tmpDir}"`, { stdio: "pipe" });

      // Verify snapshot was created with file entries
      const snapshotManager = new SnapshotManager(tmpDir);
      const snapshot = await snapshotManager.load();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.files.size).toBeGreaterThanOrEqual(3);
      expect(snapshot!.files.has("file1.txt")).toBe(true);
      expect(snapshot!.files.has("file2.txt")).toBe(true);
      expect(snapshot!.files.has("subdir/nested.txt")).toBe(true);
    });

    it("should handle empty directory during init", async () => {
      // Run pushwork init on empty directory
      execSync(`${pushworkCmd} init "${tmpDir}"`, { stdio: "pipe" });

      // Verify snapshot was created (even if empty)
      const snapshotManager = new SnapshotManager(tmpDir);
      const snapshot = await snapshotManager.load();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.files.size).toBe(0);
    });

    it("should respect exclude patterns during initial sync", async () => {
      // Create files, including some that should be excluded by default
      await fs.writeFile(path.join(tmpDir, "included.txt"), "Include me");
      await fs.mkdir(path.join(tmpDir, "node_modules"));
      await fs.writeFile(
        path.join(tmpDir, "node_modules", "package.json"),
        "{}"
      );
      await fs.mkdir(path.join(tmpDir, ".git"));
      await fs.writeFile(
        path.join(tmpDir, ".git", "config"),
        "[core]"
      );

      // Run pushwork init
      execSync(`${pushworkCmd} init "${tmpDir}"`, { stdio: "pipe" });

      // Verify snapshot only contains included file
      const snapshotManager = new SnapshotManager(tmpDir);
      const snapshot = await snapshotManager.load();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.files.has("included.txt")).toBe(true);
      // node_modules and .git should be excluded by default
      expect(snapshot!.files.has("node_modules/package.json")).toBe(false);
      expect(snapshot!.files.has(".git/config")).toBe(false);
    });
  });
});
