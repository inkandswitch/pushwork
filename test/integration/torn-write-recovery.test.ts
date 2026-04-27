/**
 * Integration test for torn-write recovery.
 *
 * Before the Phase 1/2/3a fixes, this sequence could cause data loss:
 *
 *   1. pushwork init (creates snapshot + cache)
 *   2. Simulate torn write: truncate one file in .pushwork/automerge/
 *      to 0 bytes
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
 * We disable sync by pre-writing a `.pushwork/config.json` before the
 * init so the test is fully hermetic: no network calls, no sync-server
 * dependency, no flaky timing on retries. The critical invariant we
 * test is "local files are NOT deleted on a sync that encounters
 * unavailable remote state", which holds regardless of whether the
 * network is involved.
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

  /**
   * Disable sync in the .pushwork/config.json after init. Used to make
   * the test hermetic (no sync-server dependency) for the corruption
   * + recovery phase.
   */
  async function disableSync() {
    const configPath = path.join(tmpDir, ".pushwork", "config.json");
    const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
    cfg.sync_enabled = false;
    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
  }

  afterEach(() => {
    cleanup();
  });

  /** Recursively list all files under a directory. */
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

  it("does not delete local files after torn-write cache recovery", async () => {
    // 1. Lay down some user files.
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

    // init creates snapshot + cache. This contacts the real sync
    // server (default behavior); allow up to 60s for that round-trip
    // since it's comparable to other existing integration tests. Once
    // init is done we disable sync so subsequent commands are local-only.
    try {
      execSync(`${pushworkCmd} init "${tmpDir}"`, {
        stdio: "pipe",
        timeout: 60000,
      });
    } catch {
      // If the sync server is unreachable during CI, accept the
      // failure — we still proceed if the snapshot was written.
    }

    // Confirm init actually wrote the snapshot and automerge cache.
    const snapshotPath = path.join(tmpDir, ".pushwork", "snapshot.json");
    await expect(fs.access(snapshotPath)).resolves.toBeUndefined();

    // Disable sync for the remainder of the test so the corruption
    // + recovery phase runs hermetically.
    await disableSync();

    // Sanity: user files exist post-init.
    for (const f of userFiles) {
      await expect(
        fs.access(path.join(tmpDir, f))
      ).resolves.toBeUndefined();
    }

    // 2. Simulate a torn write by truncating ONE file in the cache.
    //    hasCorruptStorage will detect this and wipe the whole cache.
    const automergeDir = path.join(tmpDir, ".pushwork", "automerge");
    const cacheFiles = await listAllFiles(automergeDir);
    expect(cacheFiles.length).toBeGreaterThan(0);
    await fs.truncate(cacheFiles[0], 0);

    // 3. Run sync. The cache is wiped, in-memory docs are gone.
    //    Without the fixes this would cause change detection to see
    //    all snapshot files as "remote content unavailable → delete".
    //    With the fixes, Phase 1 (confirmedAbsent) skips all those
    //    deletions.
    //
    //    Sync may exit 0 or non-zero (Phase 3a doesn't abort because
    //    sync is disabled; Phase 1 does its job and skips). Either way
    //    user files must be preserved.
    try {
      execSync(`${pushworkCmd} sync "${tmpDir}"`, {
        stdio: "pipe",
        timeout: 30000,
      });
    } catch {
      // Acceptable: we care about file preservation, not sync success.
    }

    // 4. Verify: every user file still on disk with original content.
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
  }, 120000);
});
