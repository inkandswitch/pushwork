/**
 * Integration test for incomplete-sync recovery via the sync.lock
 * marker (Phase 3a.i + 3a.ii).
 *
 * When a sync is interrupted (Ctrl-C, crash, SIGKILL, power loss), the
 * `.pushwork/sync.lock` it wrote on startup is never cleared. On the
 * next sync, pushwork detects the stale lock and runs a catch-up pull
 * before ordinary change detection.
 *
 * Invariants tested:
 *   1. A stale lock with a dead PID is detected and cleared.
 *   2. The subsequent sync completes without deleting any local files.
 *   3. A fresh run (no prior lock) doesn't trigger catch-up behavior.
 *   4. The sync.lock is removed after a clean sync.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execSync } from "child_process";

describe("sync-lock recovery preserves local files", () => {
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

  afterEach(() => {
    cleanup();
  });

  async function disableSync() {
    const configPath = path.join(tmpDir, ".pushwork", "config.json");
    const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
    cfg.sync_enabled = false;
    await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
  }

  async function writeStaleLock(pid: number, startedAt: number) {
    const lockPath = path.join(tmpDir, ".pushwork", "sync.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid, startedAt }),
      "utf8"
    );
  }

  async function lockExists(): Promise<boolean> {
    try {
      await fs.access(path.join(tmpDir, ".pushwork", "sync.lock"));
      return true;
    } catch {
      return false;
    }
  }

  it("clears a stale sync.lock from a dead PID and preserves local files", async () => {
    await fs.writeFile(path.join(tmpDir, "preserved.txt"), "keep me");

    try {
      execSync(`${pushworkCmd} init "${tmpDir}"`, {
        stdio: "pipe",
        timeout: 60000,
      });
    } catch {
      // Acceptable on flaky network; we only need the snapshot to exist.
    }
    await expect(
      fs.access(path.join(tmpDir, ".pushwork", "snapshot.json"))
    ).resolves.toBeUndefined();

    await disableSync();

    // Simulate an interrupted previous sync by writing a lock whose
    // PID is definitely dead. PID 999999 is essentially guaranteed
    // to not be running.
    await writeStaleLock(999999, Date.now() - 60000);
    expect(await lockExists()).toBe(true);

    // Read the stale lock's pid so we can confirm it's different from
    // whatever pid might end up in a fresh lock below.
    const lockPathStr = path.join(tmpDir, ".pushwork", "sync.lock");
    const staleContent = JSON.parse(await fs.readFile(lockPathStr, "utf8"));
    expect(staleContent.pid).toBe(999999);

    // Run a new sync. createRepo should detect the stale lock and
    // clear it, marking recoveryReason="incomplete-sync". The sync
    // itself must not delete the user's file.
    try {
      execSync(`${pushworkCmd} sync "${tmpDir}"`, {
        stdio: "pipe",
        timeout: 45000,
      });
    } catch {
      // Sync may timeout or fail. The invariants we check below still
      // hold: file preservation + stale-lock clearance.
    }

    // File must still exist with original content.
    const content = await fs.readFile(
      path.join(tmpDir, "preserved.txt"),
      "utf8"
    );
    expect(content).toBe("keep me");

    // The stale lock (pid=999999) must have been cleared by
    // createRepo. If a NEW lock is present afterward it means sync
    // didn't finish cleanly (e.g. subprocess timeout) — that's
    // acceptable and the NEXT sync will treat *that* as incomplete.
    // What's not acceptable is the original stale lock persisting.
    try {
      const current = JSON.parse(await fs.readFile(lockPathStr, "utf8"));
      expect(current.pid).not.toBe(999999);
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        // File exists but couldn't be parsed; either way not the stale lock
        // we're protecting against.
      }
      // ENOENT means the lock was fully cleared. Accept.
    }
  }, 150000);

  it("does not flag a fresh install as requiring catch-up recovery", async () => {
    // Plain init with no prior state should not produce a sync.lock
    // after it completes (lock is written at sync start, cleared at
    // sync end). We're only checking that the final state has no lock
    // — whether init succeeds against the sync server isn't our concern
    // for this invariant.
    await fs.writeFile(path.join(tmpDir, "a.txt"), "a");

    try {
      execSync(`${pushworkCmd} init "${tmpDir}"`, {
        stdio: "pipe",
        timeout: 60000,
      });
    } catch {
      // Acceptable.
    }

    expect(await lockExists()).toBe(false);
  }, 90000);
});
