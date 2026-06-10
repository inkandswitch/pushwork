/**
 * Tests for repo-factory.ts backend selection.
 *
 * The actual Repo construction requires Wasm initialization via real ESM
 * dynamic imports. We test by invoking the CLI as a subprocess (which runs
 * in a real Node.js context) and inspecting the results.
 *
 * Covers both the default Subduction backend and the `--legacy` path.
 */

import * as path from "path";
import * as fs from "fs/promises";
import * as tmp from "tmp";
import { execSync } from "child_process";

describe("createRepo (default Subduction)", () => {
  let tmpDir: string;
  let cleanup: () => void;
  const cliPath = path.join(__dirname, "../../dist/cli.js");

  beforeAll(() => {
    execSync("pnpm build", {
      cwd: path.join(__dirname, "../.."),
      stdio: "pipe",
    });
  });

  beforeEach(async () => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(() => {
    cleanup();
  });

  it("creates a working repo with default (Subduction) backend", async () => {
    await fs.writeFile(path.join(tmpDir, "test.txt"), "hello");

    execSync(`node "${cliPath}" init "${tmpDir}"`, {
      stdio: "pipe",
      timeout: 30000,
    });

    const snapshotPath = path.join(tmpDir, ".pushwork", "snapshot.json");
    const stat = await fs.stat(snapshotPath);
    expect(stat.isFile()).toBe(true);
  });

  it("produces a valid automerge URL", async () => {
    await fs.writeFile(path.join(tmpDir, "test.txt"), "hello");

    execSync(`node "${cliPath}" init "${tmpDir}"`, {
      stdio: "pipe",
      timeout: 30000,
    });

    const url = execSync(`node "${cliPath}" url "${tmpDir}"`, {
      encoding: "utf8",
      timeout: 10000,
    }).trim();

    expect(url).toMatch(/^automerge:/);
  });

  it("tracks files in the snapshot", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "aaa");
    await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "sub", "b.txt"), "bbb");

    execSync(`node "${cliPath}" init "${tmpDir}"`, {
      stdio: "pipe",
      timeout: 30000,
    });

    const ls = execSync(`node "${cliPath}" ls "${tmpDir}"`, {
      encoding: "utf8",
      timeout: 10000,
    });

    expect(ls).toContain("a.txt");
    expect(ls).toContain("b.txt");
  });

  it("can sync after init (persisted Subduction config)", async () => {
    await fs.writeFile(path.join(tmpDir, "initial.txt"), "first");

    execSync(`node "${cliPath}" init "${tmpDir}"`, {
      stdio: "pipe",
      timeout: 30000,
    });

    await fs.writeFile(path.join(tmpDir, "added.txt"), "second");

    // Sync reads the backend from .pushwork/config.json.
    execSync(`node "${cliPath}" sync "${tmpDir}"`, {
      stdio: "pipe",
      timeout: 30000,
    });

    const ls = execSync(`node "${cliPath}" ls "${tmpDir}"`, {
      encoding: "utf8",
      timeout: 10000,
    });

    expect(ls).toContain("initial.txt");
    expect(ls).toContain("added.txt");
  });
});

describe("createRepo with --legacy", () => {
  let tmpDir: string;
  let cleanup: () => void;
  const cliPath = path.join(__dirname, "../../dist/cli.js");

  beforeEach(async () => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * Run `pushwork init --legacy` and tolerate network timeouts.
   *
   * `init --legacy` calls `waitForSync` against the classic WebSocket
   * server to verify root delivery. In CI/sandboxes without outbound
   * network access, this hangs until the 60s timeout. We only care
   * that the config and snapshot were written before the network call,
   * so we invoke with a short SIGKILL timeout and ignore the exit code.
   *
   * CONTRACT: this test depends on `init` in `src/commands.ts` writing
   *   (1) `.pushwork/config.json` via `initializeRepository`, and
   *   (2) `.pushwork/snapshot.json` via `setRootDirectoryUrl`
   * BEFORE it calls `waitForSync` (the blocking network step). If that
   * ordering ever changes — e.g. sync moves earlier in init — this
   * test becomes a false positive and will need updating (ideally by
   * stubbing the network adapter in `repo-factory.ts`).
   */
  function initLegacy(dir: string): void {
    try {
      execSync(`node "${cliPath}" init --legacy "${dir}"`, {
        stdio: "pipe",
        timeout: 10000,
        killSignal: "SIGKILL",
      });
    } catch {
      // Timeouts, non-zero exits, etc. are fine — we assert on disk
      // state, which is written before the blocking network call.
    }
  }

  it("creates a working repo with --legacy flag", async () => {
    await fs.writeFile(path.join(tmpDir, "test.txt"), "hello");
    initLegacy(tmpDir);

    const snapshotPath = path.join(tmpDir, ".pushwork", "snapshot.json");
    const stat = await fs.stat(snapshotPath);
    expect(stat.isFile()).toBe(true);
  }, 30000);

  it("persists protocol: 'legacy' in config", async () => {
    await fs.writeFile(path.join(tmpDir, "test.txt"), "hello");
    initLegacy(tmpDir);

    const cfgRaw = await fs.readFile(
      path.join(tmpDir, ".pushwork", "config.json"),
      "utf8"
    );
    const cfg = JSON.parse(cfgRaw);
    expect(cfg.protocol).toBe("legacy");
    expect(cfg.config_version).toBe(1);
    expect(cfg.sync_server_storage_id).toBeDefined();
  }, 30000);
});
