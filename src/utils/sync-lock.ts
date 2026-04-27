/**
 * Sync-in-progress marker.
 *
 * A `.pushwork/sync.lock` file is written at the start of every sync
 * operation and cleared on clean completion. If the file is still
 * present at startup, it means the previous sync did NOT finish
 * cleanly (Ctrl-C, SIGKILL, OOM, crash, power loss, etc.). Pushwork
 * treats that as "requires rehydrate" and runs a catch-up pull before
 * ordinary change detection — see `SyncEngine.sync`.
 *
 * The lock records PID and start time so stale locks from dead
 * processes can be recognized and ignored.
 */

import * as fs from "fs/promises";
import * as path from "path";

export interface SyncLock {
  /** Process ID that wrote the lock. */
  pid: number;
  /** Unix millisecond timestamp when the lock was written. */
  startedAt: number;
}

/** Max lock age before it's treated as stale regardless of PID liveness. */
const MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Path to the lock file for a given `.pushwork` directory.
 */
export function syncLockPath(pushworkDir: string): string {
  return path.join(pushworkDir, "sync.lock");
}

/**
 * Write the sync-in-progress marker. Overwrites any existing lock.
 */
export async function writeSyncLock(pushworkDir: string): Promise<void> {
  const lock: SyncLock = {
    pid: process.pid,
    startedAt: Date.now(),
  };
  await fs.mkdir(pushworkDir, { recursive: true });
  await fs.writeFile(syncLockPath(pushworkDir), JSON.stringify(lock), "utf8");
}

/**
 * Read the sync lock if it exists. Returns `null` when no lock is
 * present or the file is malformed.
 */
export async function readSyncLock(
  pushworkDir: string
): Promise<SyncLock | null> {
  try {
    const raw = await fs.readFile(syncLockPath(pushworkDir), "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "number"
    ) {
      return null;
    }
    return parsed as SyncLock;
  } catch {
    return null;
  }
}

/**
 * Remove the sync lock. Idempotent: succeeds even if the lock is absent.
 */
export async function clearSyncLock(pushworkDir: string): Promise<void> {
  try {
    await fs.unlink(syncLockPath(pushworkDir));
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
}

/**
 * True if the given lock appears to be stale — either it's older than
 * MAX_LOCK_AGE_MS or its recorded PID is no longer alive.
 *
 * Note: `process.kill(pid, 0)` is a no-op signal check. It succeeds if
 * the process exists and we have permission to signal it, and throws
 * ESRCH if the process is gone. We treat EPERM (permission) as "exists"
 * to be conservative — if another user owns that PID, the lock is not
 * necessarily ours to invalidate.
 */
export function isStaleSyncLock(lock: SyncLock, now: number = Date.now()): boolean {
  if (now - lock.startedAt > MAX_LOCK_AGE_MS) return true;
  if (lock.pid === process.pid) return false;
  try {
    process.kill(lock.pid, 0);
    return false; // process is alive
  } catch (e: any) {
    if (e?.code === "ESRCH") return true; // process gone
    if (e?.code === "EPERM") return false; // exists, not ours to kill
    return true; // unknown error: treat as stale
  }
}
