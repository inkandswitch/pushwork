/**
 * Unit tests for `src/utils/sync-lock.ts`.
 *
 * The sync lock is written at the start of every sync() and cleared on
 * clean completion. If a lock is still present at startup, the previous
 * sync didn't finish cleanly — treat as incomplete-sync recovery.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import {
  writeSyncLock,
  readSyncLock,
  clearSyncLock,
  isStaleSyncLock,
  syncLockPath,
  SyncLock,
} from "../../src/utils/sync-lock";

describe("sync-lock", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), "pushwork-sync-lock-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe("write + read round-trip", () => {
    it("writes and reads a lock with pid and startedAt", async () => {
      await writeSyncLock(dir);
      const lock = await readSyncLock(dir);
      expect(lock).not.toBeNull();
      expect(lock!.pid).toBe(process.pid);
      expect(typeof lock!.startedAt).toBe("number");
      expect(Date.now() - lock!.startedAt).toBeLessThan(5000);
    });

    it("creates the directory if it does not exist", async () => {
      const nested = path.join(dir, "does-not-exist-yet");
      await writeSyncLock(nested);
      const lock = await readSyncLock(nested);
      expect(lock).not.toBeNull();
    });

    it("overwrites an existing lock", async () => {
      await writeSyncLock(dir);
      const first = await readSyncLock(dir);
      await new Promise(r => setTimeout(r, 5));
      await writeSyncLock(dir);
      const second = await readSyncLock(dir);
      expect(second!.startedAt).toBeGreaterThanOrEqual(first!.startedAt);
    });
  });

  describe("readSyncLock", () => {
    it("returns null when the lock file does not exist", async () => {
      const lock = await readSyncLock(dir);
      expect(lock).toBeNull();
    });

    it("returns null when the lock file is malformed JSON", async () => {
      await fs.writeFile(syncLockPath(dir), "not json", "utf8");
      const lock = await readSyncLock(dir);
      expect(lock).toBeNull();
    });

    it("returns null when the lock payload is missing required fields", async () => {
      await fs.writeFile(
        syncLockPath(dir),
        JSON.stringify({ wrong: "shape" }),
        "utf8"
      );
      const lock = await readSyncLock(dir);
      expect(lock).toBeNull();
    });
  });

  describe("clearSyncLock", () => {
    it("removes an existing lock", async () => {
      await writeSyncLock(dir);
      expect(await readSyncLock(dir)).not.toBeNull();
      await clearSyncLock(dir);
      expect(await readSyncLock(dir)).toBeNull();
    });

    it("is idempotent when no lock exists", async () => {
      await expect(clearSyncLock(dir)).resolves.toBeUndefined();
      await expect(clearSyncLock(dir)).resolves.toBeUndefined();
    });
  });

  describe("isStaleSyncLock", () => {
    it("returns false for a lock whose pid is this process", () => {
      const lock: SyncLock = { pid: process.pid, startedAt: Date.now() };
      expect(isStaleSyncLock(lock)).toBe(false);
    });

    it("returns true for a lock whose pid does not exist", () => {
      // PID 999999 is extremely unlikely to be a running process.
      const lock: SyncLock = { pid: 999999, startedAt: Date.now() };
      expect(isStaleSyncLock(lock)).toBe(true);
    });

    it("returns true for an ancient lock regardless of pid liveness", () => {
      const ancient: SyncLock = {
        pid: process.pid,
        startedAt: Date.now() - 48 * 60 * 60 * 1000, // 48 hours ago
      };
      expect(isStaleSyncLock(ancient)).toBe(true);
    });

    it("respects the now parameter for age checks", () => {
      const lock: SyncLock = {
        pid: process.pid,
        startedAt: 1_000_000_000_000, // old
      };
      // If `now` is right after startedAt, not stale (young).
      expect(isStaleSyncLock(lock, 1_000_000_001_000)).toBe(false);
      // If `now` is far in the future, stale (too old).
      expect(isStaleSyncLock(lock, 1_000_000_000_000 + 48 * 60 * 60 * 1000 + 1)).toBe(true);
    });
  });
});
