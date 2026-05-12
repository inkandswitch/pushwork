/**
 * Tests for repo-factory.ts Subduction configuration.
 *
 * The actual Repo construction requires Wasm initialization via real ESM
 * dynamic imports. We test by invoking the CLI as a subprocess (which runs
 * in a real Node.js context) and inspecting the results.
 *
 * Non-sub (WebSocket) init is tested elsewhere (init-sync.test.ts).
 * These tests focus on the --sub path.
 */

import * as path from "path";
import * as fs from "fs/promises";
import * as tmp from "tmp";
import { execSync } from "child_process";

// The CLI bundle (`dist/cli.js`) is built once by `test/jest.globalSetup.ts`
// before any worker spawns; no per-suite build is needed here.
describe("createRepo with --sub", () => {
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

  // `init --sub` and `sync` against the live Subduction server can take
  // longer than Jest's default 5s test timeout. The execSync timeout is
  // kept slightly below the Jest per-test timeout so that a network stall
  // surfaces as the underlying CLI error rather than Jest's generic
  // "exceeded timeout" message.
  const INIT_TIMEOUT_MS = 50000;
  const FAST_TIMEOUT_MS = 15000;
  const JEST_TIMEOUT_MS = 60000;

  it(
    "should create a working repo with --sub flag",
    async () => {
      await fs.writeFile(path.join(tmpDir, "test.txt"), "hello");

      execSync(`node "${cliPath}" init --sub "${tmpDir}"`, {
        stdio: "pipe",
        timeout: INIT_TIMEOUT_MS,
      });

      const snapshotPath = path.join(tmpDir, ".pushwork", "snapshot.json");
      const stat = await fs.stat(snapshotPath);
      expect(stat.isFile()).toBe(true);
    },
    JEST_TIMEOUT_MS
  );

  it(
    "should produce a valid automerge URL",
    async () => {
      await fs.writeFile(path.join(tmpDir, "test.txt"), "hello");

      execSync(`node "${cliPath}" init --sub "${tmpDir}"`, {
        stdio: "pipe",
        timeout: INIT_TIMEOUT_MS,
      });

      const url = execSync(`node "${cliPath}" url "${tmpDir}"`, {
        encoding: "utf8",
        timeout: FAST_TIMEOUT_MS,
      }).trim();

      expect(url).toMatch(/^automerge:/);
    },
    JEST_TIMEOUT_MS
  );

  it(
    "should track files in the snapshot",
    async () => {
      await fs.writeFile(path.join(tmpDir, "a.txt"), "aaa");
      await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "sub", "b.txt"), "bbb");

      execSync(`node "${cliPath}" init --sub "${tmpDir}"`, {
        stdio: "pipe",
        timeout: INIT_TIMEOUT_MS,
      });

      const ls = execSync(`node "${cliPath}" ls "${tmpDir}"`, {
        encoding: "utf8",
        timeout: FAST_TIMEOUT_MS,
      });

      expect(ls).toContain("a.txt");
      expect(ls).toContain("b.txt");
    },
    JEST_TIMEOUT_MS
  );

  it(
    "should be able to sync after init",
    async () => {
      await fs.writeFile(path.join(tmpDir, "initial.txt"), "first");

      execSync(`node "${cliPath}" init --sub "${tmpDir}"`, {
        stdio: "pipe",
        timeout: INIT_TIMEOUT_MS,
      });

      // Add a new file
      await fs.writeFile(path.join(tmpDir, "added.txt"), "second");

      // Sync should not throw. The `sync` command has no --sub flag — it
      // reads the backend choice from .pushwork/config.json (persisted by
      // the init --sub above).
      execSync(`node "${cliPath}" sync "${tmpDir}"`, {
        stdio: "pipe",
        timeout: INIT_TIMEOUT_MS,
      });

      const ls = execSync(`node "${cliPath}" ls "${tmpDir}"`, {
        encoding: "utf8",
        timeout: FAST_TIMEOUT_MS,
      });

      expect(ls).toContain("initial.txt");
      expect(ls).toContain("added.txt");
    },
    JEST_TIMEOUT_MS
  );
});
