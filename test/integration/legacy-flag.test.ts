import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execSync, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { SnapshotManager } from "../../src/core";
import { ConfigManager } from "../../src/core/config";

const execFile = promisify(execFileCb);

describe("backend selection integration (default: Subduction, --legacy opts out)", () => {
  let tmpDir: string;
  let cleanup: () => void;
  const cliPath = path.join(__dirname, "../../dist/cli.js");

  beforeAll(() => {
    execSync("pnpm build", {
      cwd: path.join(__dirname, "../.."),
      stdio: "pipe",
    });
  });

  beforeEach(() => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(() => {
    cleanup();
  });

  async function pushwork(args: string[], timeoutMs = 30000): Promise<string> {
    const { stdout } = await execFile("node", [cliPath, ...args], {
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return stdout;
  }

  // Run the CLI expecting a non-zero exit (e.g. argument validation).
  // Returns the exit code + stderr. Rethrows if the process was killed
  // (timeout) or unexpectedly succeeded.
  async function pushworkExpectFailure(
    args: string[],
    timeoutMs = 15000
  ): Promise<{ code: number; stderr: string }> {
    let result: { stdout: string };
    try {
      result = await execFile("node", [cliPath, ...args], {
        timeout: timeoutMs,
        env: { ...process.env, NO_COLOR: "1" },
      });
    } catch (err: any) {
      if (err.killed) throw err; // timeout, not a clean validation failure
      return {
        code: typeof err.code === "number" ? err.code : 1,
        stderr: String(err.stderr ?? ""),
      };
    }
    throw new Error(
      `expected a non-zero exit but the command succeeded:\n${result.stdout}`
    );
  }

  describe("init (default, no flag → Subduction)", () => {
    it("initializes a directory with default Subduction backend", async () => {
      await fs.writeFile(path.join(tmpDir, "hello.txt"), "Hello, world!");

      await pushwork(["init", tmpDir]);

      const pushworkDir = path.join(tmpDir, ".pushwork");
      const stat = await fs.stat(pushworkDir);
      expect(stat.isDirectory()).toBe(true);

      const snapshotManager = new SnapshotManager(tmpDir);
      const snapshot = await snapshotManager.load();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.rootDirectoryUrl).toMatch(/^automerge:/);
      expect(snapshot!.files.has("hello.txt")).toBe(true);

      const cfg = await new ConfigManager(tmpDir).load();
      expect(cfg?.protocol).toBe("subduction");
      expect(cfg?.config_version).toBe(1);
      expect(cfg?.sync_server_storage_id).toBeUndefined();
    }, 60000);

    it("tracks files in subdirectories", async () => {
      await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, "src", "index.ts"),
        "export default {}"
      );
      await fs.writeFile(path.join(tmpDir, "package.json"), '{"name":"t"}');

      await pushwork(["init", tmpDir]);

      const snapshot = await new SnapshotManager(tmpDir).load();
      expect(snapshot!.files.has("src/index.ts")).toBe(true);
      expect(snapshot!.files.has("package.json")).toBe(true);
    }, 60000);

    it("respects default exclude patterns", async () => {
      await fs.writeFile(path.join(tmpDir, "included.txt"), "keep me");
      await fs.mkdir(path.join(tmpDir, "node_modules"));
      await fs.writeFile(
        path.join(tmpDir, "node_modules", "dep.js"),
        "module"
      );
      await fs.mkdir(path.join(tmpDir, ".git"));
      await fs.writeFile(
        path.join(tmpDir, ".git", "HEAD"),
        "ref: refs/heads/main"
      );

      await pushwork(["init", tmpDir]);

      const snapshot = await new SnapshotManager(tmpDir).load();
      expect(snapshot!.files.has("included.txt")).toBe(true);
      expect(snapshot!.files.has("node_modules/dep.js")).toBe(false);
      expect(snapshot!.files.has(".git/HEAD")).toBe(false);
    }, 60000);
  });

  describe("init --legacy", () => {
    it("initializes with legacy WebSocket backend and storage_id", async () => {
      await fs.writeFile(path.join(tmpDir, "classic.txt"), "legacy sync");

      await pushwork(["init", "--legacy", tmpDir]);

      const snapshot = await new SnapshotManager(tmpDir).load();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.files.has("classic.txt")).toBe(true);

      const cfg = await new ConfigManager(tmpDir).load();
      expect(cfg?.protocol).toBe("legacy");
      expect(cfg?.config_version).toBe(1);
      expect(cfg?.sync_server_storage_id).toBeDefined();
      expect(cfg?.sync_server).toContain("sync3.automerge.org");
    }, 60000);
  });

  describe("sync (reads backend from persisted config)", () => {
    it("syncs after default init (Subduction)", async () => {
      await fs.writeFile(path.join(tmpDir, "file1.txt"), "initial");

      await pushwork(["init", tmpDir]);
      await fs.writeFile(path.join(tmpDir, "file2.txt"), "new file");
      await pushwork(["sync", tmpDir]);

      const snapshot = await new SnapshotManager(tmpDir).load();
      expect(snapshot!.files.has("file1.txt")).toBe(true);
      expect(snapshot!.files.has("file2.txt")).toBe(true);
    }, 60000);

    it("syncs after init --legacy (WebSocket)", async () => {
      await fs.writeFile(path.join(tmpDir, "a.txt"), "one");

      await pushwork(["init", "--legacy", tmpDir]);
      await fs.writeFile(path.join(tmpDir, "b.txt"), "two");
      await pushwork(["sync", tmpDir]);

      const snapshot = await new SnapshotManager(tmpDir).load();
      expect(snapshot!.files.has("a.txt")).toBe(true);
      expect(snapshot!.files.has("b.txt")).toBe(true);

      // Config still reports legacy protocol after sync.
      const cfg = await new ConfigManager(tmpDir).load();
      expect(cfg?.protocol).toBe("legacy");
    }, 60000);

    it("detects file modifications on sync", async () => {
      await fs.writeFile(path.join(tmpDir, "mutable.txt"), "v1");

      await pushwork(["init", tmpDir]);

      const snap1 = await new SnapshotManager(tmpDir).load();
      const initialHead = snap1!.files.get("mutable.txt")!.head;

      await fs.writeFile(path.join(tmpDir, "mutable.txt"), "v2");
      await pushwork(["sync", tmpDir]);

      const snap2 = await new SnapshotManager(tmpDir).load();
      const updatedHead = snap2!.files.get("mutable.txt")!.head;
      expect(updatedHead).not.toEqual(initialHead);
    }, 60000);

    it("handles file deletions on sync", async () => {
      await fs.writeFile(path.join(tmpDir, "ephemeral.txt"), "bye");
      await fs.writeFile(path.join(tmpDir, "keeper.txt"), "stay");

      await pushwork(["init", tmpDir]);

      await fs.unlink(path.join(tmpDir, "ephemeral.txt"));
      await pushwork(["sync", tmpDir]);

      const snapshot = await new SnapshotManager(tmpDir).load();
      expect(snapshot!.files.has("ephemeral.txt")).toBe(false);
      expect(snapshot!.files.has("keeper.txt")).toBe(true);
    }, 60000);
  });

  describe("--sync-server storage-id validation (D9)", () => {
    it("rejects a storage ID without --legacy (Subduction default)", async () => {
      const { code, stderr } = await pushworkExpectFailure([
        "init",
        tmpDir,
        "--sync-server",
        "wss://example.com",
        "some-storage-id",
      ]);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/storage ID is only valid with --legacy/i);

      // Validation fails before any setup — nothing should be initialized.
      await expect(
        fs.stat(path.join(tmpDir, ".pushwork"))
      ).rejects.toThrow();
    }, 30000);

    it("requires a storage ID when --legacy is set", async () => {
      const { code, stderr } = await pushworkExpectFailure([
        "init",
        tmpDir,
        "--legacy",
        "--sync-server",
        "wss://example.com",
      ]);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/requires both a URL and a storage ID/i);
    }, 30000);
  });

  describe("Automerge URL validation", () => {
    it("rejects clone of a malformed Automerge URL (not just the prefix)", async () => {
      // All fail at URL parsing before any fs/network work, so no empty
      // clone directory is ever created.
      for (const bad of [
        "automerge:",
        "automerge:garbage",
        "automerge:!!!notbase58!!!",
        "https://example.com/doc",
      ]) {
        const { code } = await pushworkExpectFailure([
          "clone",
          bad,
          path.join(tmpDir, "clone-target"),
        ]);
        expect(code).not.toBe(0);
      }
    }, 30000);

    it("rejects track of a malformed Automerge URL", async () => {
      const { code, stderr } = await pushworkExpectFailure([
        "track",
        "automerge:garbage",
        path.join(tmpDir, "track-target"),
      ]);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/Invalid Automerge URL/i);
    }, 30000);
  });

  describe("conflicting sync modes (W11)", () => {
    it("rejects --gentle together with --nuclear", async () => {
      // The conflict is detected before any repo/network work, so an
      // uninitialized dir is fine for this assertion.
      const { code, stderr } = await pushworkExpectFailure([
        "sync",
        tmpDir,
        "--gentle",
        "--nuclear",
        "--dry-run",
      ]);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/--gentle and --nuclear cannot be used together/i);
    }, 30000);
  });

  describe("url / status / diff", () => {
    it("url prints a valid automerge URL", async () => {
      await pushwork(["init", tmpDir]);
      const stdout = await pushwork(["url", tmpDir]);
      expect(stdout.trim()).toMatch(/^automerge:/);
    }, 60000);

    it("status reports without errors", async () => {
      await fs.writeFile(path.join(tmpDir, "t.txt"), "ok");
      await pushwork(["init", tmpDir]);
      const stdout = await pushwork(["status", tmpDir]);
      expect(stdout).toBeDefined();
    }, 60000);

    it("diff shows no changes immediately after init", async () => {
      await fs.writeFile(path.join(tmpDir, "stable.txt"), "no changes");
      await pushwork(["init", tmpDir]);
      const stdout = await pushwork(["diff", tmpDir]);
      expect(stdout).not.toContain("modified");
    }, 60000);
  });
});
