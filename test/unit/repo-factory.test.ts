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

describe("createRepo with --sub", () => {
  let tmpDir: string;
  let cleanup: () => void;
  const cliPath = path.join(__dirname, "../../dist/cli.js");

  beforeAll(() => {
    execSync("pnpm build", { cwd: path.join(__dirname, "../.."), stdio: "pipe" });
  });

  beforeEach(async () => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(() => {
    cleanup();
  });

  it("should create a working repo with --sub flag", async () => {
    await fs.writeFile(path.join(tmpDir, "test.txt"), "hello");

    execSync(`node "${cliPath}" init --sub "${tmpDir}"`, {
      stdio: "pipe",
      timeout: 30000,
    });

    const snapshotPath = path.join(tmpDir, ".pushwork", "snapshot.json");
    const stat = await fs.stat(snapshotPath);
    expect(stat.isFile()).toBe(true);
  });

  it("should produce a valid automerge URL", async () => {
    await fs.writeFile(path.join(tmpDir, "test.txt"), "hello");

    execSync(`node "${cliPath}" init --sub "${tmpDir}"`, {
      stdio: "pipe",
      timeout: 30000,
    });

    const url = execSync(`node "${cliPath}" url "${tmpDir}"`, {
      encoding: "utf8",
      timeout: 10000,
    }).trim();

    expect(url).toMatch(/^automerge:/);
  });

  it("should track files in the snapshot", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "aaa");
    await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "sub", "b.txt"), "bbb");

    execSync(`node "${cliPath}" init --sub "${tmpDir}"`, {
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

  it("should be able to sync after init", async () => {
    await fs.writeFile(path.join(tmpDir, "initial.txt"), "first");

    execSync(`node "${cliPath}" init --sub "${tmpDir}"`, {
      stdio: "pipe",
      timeout: 30000,
    });

    // Add a new file
    await fs.writeFile(path.join(tmpDir, "added.txt"), "second");

    // Sync should not throw. The `sync` command has no --sub flag — it
    // reads the backend choice from .pushwork/config.json (persisted by
    // the init --sub above).
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
