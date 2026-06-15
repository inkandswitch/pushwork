/**
 * pvh TODO: the files & directories could be unified into a single map of entries with a type field
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  SyncSnapshot,
  SerializableSyncSnapshot,
  SnapshotFileEntry,
  SnapshotDirectoryEntry,
} from "../types";
import { pathExists, ensureDirectoryExists } from "../utils";
import { out } from "../utils/output";

/**
 * Manages sync snapshots for local state tracking
 */
export class SnapshotManager {
  private static readonly SNAPSHOT_FILENAME = "snapshot.json";
  private static readonly SYNC_TOOL_DIR = ".pushwork";

  constructor(private rootPath: string) {}

  private getSyncToolDir(): string {
    return path.join(this.rootPath, SnapshotManager.SYNC_TOOL_DIR);
  }

  private getSnapshotPath(): string {
    return path.join(this.getSyncToolDir(), SnapshotManager.SNAPSHOT_FILENAME);
  }

  async exists(): Promise<boolean> {
    return await pathExists(this.getSnapshotPath());
  }

  /** Returns null if the snapshot is missing or unreadable. */
  async load(): Promise<SyncSnapshot | null> {
    try {
      const snapshotPath = this.getSnapshotPath();
      if (!(await pathExists(snapshotPath))) {
        return null;
      }

      const content = await fs.readFile(snapshotPath, "utf8");
      const serializable: SerializableSyncSnapshot = JSON.parse(content);

      return this.deserializeSnapshot(serializable);
    } catch (error) {
      out.taskLine(`Failed to load snapshot: ${error}`);
      return null;
    }
  }

  async save(snapshot: SyncSnapshot): Promise<void> {
    try {
      await ensureDirectoryExists(this.getSyncToolDir());

      const serializable = this.serializeSnapshot(snapshot);
      const content = JSON.stringify(serializable, null, 2);

      await fs.writeFile(this.getSnapshotPath(), content, "utf8");
    } catch (error) {
      throw new Error(`Failed to save snapshot: ${error}`);
    }
  }

  createEmpty(): SyncSnapshot {
    return {
      timestamp: Date.now(),
      rootPath: this.rootPath,
      rootDirectoryUrl: undefined,
      files: new Map(),
      directories: new Map(),
    };
  }

  updateFileEntry(
    snapshot: SyncSnapshot,
    relativePath: string,
    entry: SnapshotFileEntry
  ): void {
    snapshot.files.set(relativePath, entry);
    snapshot.timestamp = Date.now();
  }

  updateDirectoryEntry(
    snapshot: SyncSnapshot,
    relativePath: string,
    entry: SnapshotDirectoryEntry
  ): void {
    snapshot.directories.set(relativePath, entry);
    snapshot.timestamp = Date.now();
  }

  removeFileEntry(snapshot: SyncSnapshot, relativePath: string): void {
    snapshot.files.delete(relativePath);
    snapshot.timestamp = Date.now();
  }

  removeDirectoryEntry(snapshot: SyncSnapshot, relativePath: string): void {
    snapshot.directories.delete(relativePath);
    snapshot.timestamp = Date.now();
  }

  getFilePaths(snapshot: SyncSnapshot): string[] {
    return Array.from(snapshot.files.keys());
  }

  getDirectoryPaths(snapshot: SyncSnapshot): string[] {
    return Array.from(snapshot.directories.keys());
  }

  getFileEntry(
    snapshot: SyncSnapshot,
    relativePath: string
  ): SnapshotFileEntry | undefined {
    return snapshot.files.get(relativePath);
  }

  getDirectoryEntry(
    snapshot: SyncSnapshot,
    relativePath: string
  ): SnapshotDirectoryEntry | undefined {
    return snapshot.directories.get(relativePath);
  }

  isTracked(snapshot: SyncSnapshot, relativePath: string): boolean {
    return (
      snapshot.files.has(relativePath) || snapshot.directories.has(relativePath)
    );
  }

  getStats(snapshot: SyncSnapshot): {
    files: number;
    directories: number;
    timestamp: Date;
  } {
    return {
      files: snapshot.files.size,
      directories: snapshot.directories.size,
      timestamp: new Date(snapshot.timestamp),
    };
  }

  /**
   * Validate snapshot integrity
   */
  validate(snapshot: SyncSnapshot): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!snapshot.timestamp || snapshot.timestamp <= 0) {
      errors.push("Invalid timestamp");
    }

    if (!snapshot.rootPath) {
      errors.push("Missing root path");
    }

    if (!snapshot.files || !snapshot.directories) {
      errors.push("Missing files or directories map");
    }

    // Check for path conflicts (file and directory with same path)
    for (const filePath of snapshot.files.keys()) {
      if (snapshot.directories.has(filePath)) {
        errors.push(
          `Path conflict: ${filePath} exists as both file and directory`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private serializeSnapshot(snapshot: SyncSnapshot): SerializableSyncSnapshot {
    return {
      timestamp: snapshot.timestamp,
      rootPath: snapshot.rootPath,
      rootDirectoryUrl: snapshot.rootDirectoryUrl,
      files: Array.from(snapshot.files.entries()),
      directories: Array.from(snapshot.directories.entries()),
    };
  }

  private deserializeSnapshot(
    serializable: SerializableSyncSnapshot
  ): SyncSnapshot {
    return {
      timestamp: serializable.timestamp,
      rootPath: serializable.rootPath,
      rootDirectoryUrl: serializable.rootDirectoryUrl,
      files: new Map(serializable.files),
      directories: new Map(serializable.directories),
    };
  }

  clear(snapshot: SyncSnapshot): void {
    snapshot.files.clear();
    snapshot.directories.clear();
    snapshot.timestamp = Date.now();
  }

  /** Shallow copy (new Maps; entry objects shared). */
  clone(snapshot: SyncSnapshot): SyncSnapshot {
    return {
      timestamp: snapshot.timestamp,
      rootPath: snapshot.rootPath,
      rootDirectoryUrl: snapshot.rootDirectoryUrl,
      files: new Map(snapshot.files),
      directories: new Map(snapshot.directories),
    };
  }
}
