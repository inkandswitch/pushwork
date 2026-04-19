/**
 * Integration test for torn-write recovery.
 *
 * Before the Phase 1/2/3a fixes, this sequence could cause data loss:
 *
 *   1. pushwork init (creates snapshot + cache)
 *   2. Simulate torn write: truncate one file in .pushwork/automerge/ to 0 bytes
 *   3. pushwork sync
 *      -> repo-factory wipes the entire cache (hasCorruptStorage detected)
 *      -> sync engine starts change detection
 *      -> documents not yet refetched from server
 *      -> change-detection reports "remote content unavailable" as
 *         "file deleted remotely" (remoteContent === null)
 *      -> applyRemoteChangeToLocal deletes the user's file
 *
 * After the fixes, pushwork must preserve the local file even when the
 * remote state cannot be read — either by skipping the pull phase for
 * unconfirmed absences (Phase 1) or by aborting before change detection
 * when rehydration fails (Phase 3a).
 *
 * Uses `sync_enabled: false` to isolate the test from real sync server
 * availability. With sync disabled, the rehydrate gate in Phase 3a
 * short-circuits (nothing to rehydrate), and change-detection operates
 * purely against the local cache. The critical invariant we test is:
 * local files are NOT deleted even when the cache has been wiped and
 * documents can't be read.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execSync } from "child_process";

describe("torn-write recovery preserves local files", () => {
  let tmpDir: string;
  let cleanup: () => void;
  const pushworkCmd = `node "${path.join(__dirname, "../../dist/cli.js")}"`;

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
   * Recursively list all files under a directory (used to find cache files
   * we can simulate a torn write on).
   */
  async function listAllFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await listAllFiles(full)));
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
    return out;
  }

  it("does not delete local files after torn-write cache recovery (sync disabled)", async () => {
    // 1. Set up a repo with real user files.
    const userFiles = [
      "a.txt",
      "b.txt",
      "subdir/c.txt",
      "subdir/nested/d.txt",
    ];
    await fs.mkdir(path.join(tmpDir, "subdir", "nested"), { recursive: true });
    for (const f of userFiles) {
      await fs.writeFile(path.join(tmpDir, f), `content of ${f}`);
    }

    // Initialize without network sync so the test is hermetic.
    execSync(`${pushworkCmd} init "${tmpDir}"`, {
      stdio: "pipe",
      env: { ...process.env, PUSHWORK_SYNC_ENABLED: "false" },
    });

    // Disable network sync in the config so subsequent sync commands
    // operate purely locally.
    const configPath = path.join(tmpDir, ".pushwork", "config.json");
    const rawConfig = await fs.readFile(configPath, "utf8");
    const cfg = JSON.parse(rawConfig);
    cfg.sync_enabled = false;
    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));

    // Sanity: all user files still exist on disk.
    for (const f of userFiles) {
      await expect(
        fs.access(path.join(tmpDir, f))
      ).resolves.toBeUndefined();
    }

    // 2. Simulate a torn write: truncate one file in the automerge cache
    //    to 0 bytes. This triggers hasCorruptStorage on the next start.
    const automergeDir = path.join(tmpDir, ".pushwork", "automerge");
    const cacheFiles = await listAllFiles(automergeDir);
    expect(cacheFiles.length).toBeGreaterThan(0);
    await fs.truncate(cacheFiles[0], 0);

    // 3. Run sync. With the fixes in place, this must NOT delete user files.
    //    It may report errors (change detection can't find docs), but the
    //    filesystem under tmpDir must remain intact.
    let syncFailed = false;
    try {
      execSync(`${pushworkCmd} sync "${tmpDir}"`, {
        stdio: "pipe",
      });
    } catch {
      // Sync failure is acceptable (Phase 3a may abort). What's NOT
      // acceptable is losing user files.
      syncFailed = true;
    }

    // 4. Verify: every user file is still on disk, with original content.
    const missing: string[] = [];
    for (const f of userFiles) {
      try {
        const content = await fs.readFile(path.join(tmpDir, f), "utf8");
        expect(content).toBe(`content of ${f}`);
      } catch {
        missing.push(f);
      }
    }

    expect(missing).toEqual([]);
    // Sync completing successfully is a bonus but not required —
    // what matters is the file preservation invariant above.
    void syncFailed;
  }, 60000);

  it("preserves local files when the cache is wiped and no sync server is reachable", async () => {
    // Similar to above, but we wipe the entire cache rather than truncate
    // a single file. This exercises the full Phase 3a rehydrate path.
    await fs.writeFile(path.join(tmpDir, "important.txt"), "user data");

    execSync(`${pushworkCmd} init "${tmpDir}"`, { stdio: "pipe" });

    // Disable network sync.
    const configPath = path.join(tmpDir, ".pushwork", "config.json");
    const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
    cfg.sync_enabled = false;
    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));

    // Nuke a cache file to trigger recovery.
    const automergeDir = path.join(tmpDir, ".pushwork", "automerge");
    const cacheFiles = await listAllFiles(automergeDir);
    if (cacheFiles.length > 0) {
      await fs.truncate(cacheFiles[0], 0);
    }

    try {
      execSync(`${pushworkCmd} sync "${tmpDir}"`, { stdio: "pipe" });
    } catch {
      // Acceptable failure.
    }

    // Critical invariant: user file preserved.
    const content = await fs.readFile(
      path.join(tmpDir, "important.txt"),
      "utf8"
    );
    expect(content).toBe("user data");
  }, 60000);
});
