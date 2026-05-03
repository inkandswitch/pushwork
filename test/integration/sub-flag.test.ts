import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execSync, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { SnapshotManager } from "../../src/core";

const execFile = promisify(execFileCb);

describe("--sub flag integration", () => {
  let tmpDir: string;
  let cleanup: () => void;
  const cliPath = path.join(__dirname, "../../dist/cli.js");

  beforeAll(() => {
    execSync("pnpm build", { cwd: path.join(__dirname, "../.."), stdio: "pipe" });
  });

  beforeEach(() => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * Run pushwork CLI command and return stdout.
   * Throws on non-zero exit code.
   */
  async function pushwork(args: string[], timeoutMs = 30000): Promise<string> {
    const { stdout } = await execFile("node", [cliPath, ...args], {
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return stdout;
  }

  describe("init --sub", () => {
    it("should initialize a directory with --sub flag", async () => {
      await fs.writeFile(path.join(tmpDir, "hello.txt"), "Hello from sub!");

      await pushwork(["init", "--sub", tmpDir]);

      // Verify .pushwork was created
      const pushworkDir = path.join(tmpDir, ".pushwork");
      const stat = await fs.stat(pushworkDir);
      expect(stat.isDirectory()).toBe(true);

      // Verify snapshot exists and tracks the file
      const snapshotManager = new SnapshotManager(tmpDir);
      const snapshot = await snapshotManager.load();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.rootDirectoryUrl).toBeDefined();
      expect(snapshot!.rootDirectoryUrl).toMatch(/^automerge:/);
      expect(snapshot!.files.has("hello.txt")).toBe(true);
    }, 60000);

    it("should track files in subdirectories", async () => {
      await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "src", "index.ts"), "export default {}");
      await fs.writeFile(path.join(tmpDir, "package.json"), '{"name": "test"}');

      await pushwork(["init", "--sub", tmpDir]);

      const snapshotManager = new SnapshotManager(tmpDir);
      const snapshot = await snapshotManager.load();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.files.has("src/index.ts")).toBe(true);
      expect(snapshot!.files.has("package.json")).toBe(true);
    }, 60000);

    it("should respect default exclude patterns with --sub", async () => {
      await fs.writeFile(path.join(tmpDir, "included.txt"), "keep me");
      await fs.mkdir(path.join(tmpDir, "node_modules"));
      await fs.writeFile(path.join(tmpDir, "node_modules", "dep.js"), "module");
      await fs.mkdir(path.join(tmpDir, ".git"));
      await fs.writeFile(path.join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main");

      await pushwork(["init", "--sub", tmpDir]);

      const snapshotManager = new SnapshotManager(tmpDir);
      const snapshot = await snapshotManager.load();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.files.has("included.txt")).toBe(true);
      expect(snapshot!.files.has("node_modules/dep.js")).toBe(false);
      expect(snapshot!.files.has(".git/HEAD")).toBe(false);
    }, 60000);
  });

  describe("sync (after init --sub)", () => {
    // `--sub` is only accepted on init/clone; subsequent `sync` calls read
    // the subduction flag from .pushwork/config.json.
    it("should sync after init --sub", async () => {
      await fs.writeFile(path.join(tmpDir, "file1.txt"), "initial content");

      await pushwork(["init", "--sub", tmpDir]);

      // Add a new file
      await fs.writeFile(path.join(tmpDir, "file2.txt"), "new file");

      await pushwork(["sync", tmpDir]);

      // Verify the new file is now tracked
      const snapshotManager = new SnapshotManager(tmpDir);
      const snapshot = await snapshotManager.load();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.files.has("file1.txt")).toBe(true);
      expect(snapshot!.files.has("file2.txt")).toBe(true);
    }, 60000);

    it("should detect file modifications on sync", async () => {
      await fs.writeFile(path.join(tmpDir, "mutable.txt"), "version 1");

      await pushwork(["init", "--sub", tmpDir]);

      // Record initial heads
      const snapshotManager = new SnapshotManager(tmpDir);
      const snapshot1 = await snapshotManager.load();
      const initialHead = snapshot1!.files.get("mutable.txt")!.head;

      // Modify the file
      await fs.writeFile(path.join(tmpDir, "mutable.txt"), "version 2");

      await pushwork(["sync", tmpDir]);

      // Heads should have changed
      const snapshot2 = await snapshotManager.load();
      const updatedHead = snapshot2!.files.get("mutable.txt")!.head;
      expect(updatedHead).not.toEqual(initialHead);
    }, 60000);

    it("should handle file deletions on sync", async () => {
      await fs.writeFile(path.join(tmpDir, "ephemeral.txt"), "delete me");
      await fs.writeFile(path.join(tmpDir, "keeper.txt"), "keep me");

      await pushwork(["init", "--sub", tmpDir]);

      // Delete a file
      await fs.unlink(path.join(tmpDir, "ephemeral.txt"));

      await pushwork(["sync", tmpDir]);

      // Deleted file should be gone from snapshot
      const snapshotManager = new SnapshotManager(tmpDir);
      const snapshot = await snapshotManager.load();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.files.has("ephemeral.txt")).toBe(false);
      expect(snapshot!.files.has("keeper.txt")).toBe(true);
    }, 60000);
  });

  describe("url after init --sub", () => {
    it("should print a valid automerge URL", async () => {
      await pushwork(["init", "--sub", tmpDir]);

      const stdout = await pushwork(["url", tmpDir]);
      expect(stdout.trim()).toMatch(/^automerge:/);
    }, 60000);
  });

  describe("status after init --sub", () => {
    it("should report status without errors", async () => {
      await fs.writeFile(path.join(tmpDir, "test.txt"), "status check");
      await pushwork(["init", "--sub", tmpDir]);

      // status should not throw
      const stdout = await pushwork(["status", tmpDir]);
      expect(stdout).toBeDefined();
    }, 60000);
  });

  describe("diff after init --sub", () => {
    it("should show no changes immediately after init", async () => {
      await fs.writeFile(path.join(tmpDir, "stable.txt"), "no changes");
      await pushwork(["init", "--sub", tmpDir]);

      const stdout = await pushwork(["diff", tmpDir]);
      // After a fresh init+sync, there should be no pending changes
      expect(stdout).not.toContain("modified");
    }, 60000);
  });
});
