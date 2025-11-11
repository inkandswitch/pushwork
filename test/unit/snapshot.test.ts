import * as path from "path";
import * as tmp from "tmp";
import { SnapshotManager } from "../../src/core/snapshot";
import { SnapshotFileEntry, SnapshotDirectoryEntry } from "../../src/types";
import { UrlHeads } from "@automerge/automerge-repo";

describe("SnapshotManager", () => {
  let tmpDir: string;
  let cleanup: () => void;
  let snapshotManager: SnapshotManager;

  beforeEach(() => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
    snapshotManager = new SnapshotManager(tmpDir);
  });

  afterEach(() => {
    cleanup();
  });

  describe("exists", () => {
    it("should return false when no snapshot exists", async () => {
      expect(await snapshotManager.exists()).toBe(false);
    });

    it("should return true when snapshot exists", async () => {
      const snapshot = snapshotManager.createEmpty();
      await snapshotManager.save(snapshot);

      expect(await snapshotManager.exists()).toBe(true);
    });
  });

  describe("createEmpty", () => {
    it("should create an empty snapshot", () => {
      const snapshot = snapshotManager.createEmpty();

      expect(snapshot.rootPath).toBe(tmpDir);
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.files.size).toBe(0);
      expect(snapshot.directories.size).toBe(0);
    });
  });

  describe("save and load", () => {
    it("should save and load empty snapshot", async () => {
      const originalSnapshot = snapshotManager.createEmpty();

      await snapshotManager.save(originalSnapshot);
      const loadedSnapshot = await snapshotManager.load();

      expect(loadedSnapshot).not.toBeNull();
      expect(loadedSnapshot!.rootPath).toBe(originalSnapshot.rootPath);
      expect(loadedSnapshot!.timestamp).toBe(originalSnapshot.timestamp);
      expect(loadedSnapshot!.files.size).toBe(0);
      expect(loadedSnapshot!.directories.size).toBe(0);
    });

    it("should save and load snapshot with files", async () => {
      const snapshot = snapshotManager.createEmpty();

      const fileEntry: SnapshotFileEntry = {
        path: path.join(tmpDir, "test.txt"),
        url: "automerge:test-url" as any,
        head: ["test-head"] as UrlHeads,
        extension: "txt",
        mimeType: "text/plain",
      };

      snapshotManager.updateFileEntry(snapshot, "test.txt", fileEntry);

      await snapshotManager.save(snapshot);
      const loadedSnapshot = await snapshotManager.load();

      expect(loadedSnapshot).not.toBeNull();
      expect(loadedSnapshot!.files.size).toBe(1);
      expect(loadedSnapshot!.files.get("test.txt")).toEqual(fileEntry);
    });

    it("should save and load snapshot with directories", async () => {
      const snapshot = snapshotManager.createEmpty();

      const dirEntry: SnapshotDirectoryEntry = {
        path: path.join(tmpDir, "subdir"),
        url: "automerge:dir-url" as any,
        head: ["dir-head"] as UrlHeads,
        entries: ["file1.txt", "file2.txt"],
      };

      snapshotManager.updateDirectoryEntry(snapshot, "subdir", dirEntry);

      await snapshotManager.save(snapshot);
      const loadedSnapshot = await snapshotManager.load();

      expect(loadedSnapshot).not.toBeNull();
      expect(loadedSnapshot!.directories.size).toBe(1);
      expect(loadedSnapshot!.directories.get("subdir")).toEqual(dirEntry);
    });

    it("should return null when loading non-existent snapshot", async () => {
      const loadedSnapshot = await snapshotManager.load();
      expect(loadedSnapshot).toBeNull();
    });
  });

  describe("updateFileEntry", () => {
    it("should add new file entry", () => {
      const snapshot = snapshotManager.createEmpty();
      const originalTimestamp = snapshot.timestamp;

      const fileEntry: SnapshotFileEntry = {
        path: "/test/path/test.txt",
        url: "automerge:test-url" as any,
        head: ["test-head"] as UrlHeads,
        extension: "txt",
        mimeType: "text/plain",
      };

      // Add small delay to ensure timestamp changes
      const startTime = Date.now();
      while (Date.now() === startTime) {
        // Wait for at least 1ms
      }

      snapshotManager.updateFileEntry(snapshot, "test.txt", fileEntry);

      expect(snapshot.files.get("test.txt")).toEqual(fileEntry);
      expect(snapshot.timestamp).toBeGreaterThan(originalTimestamp);
    });

    it("should update existing file entry", () => {
      const snapshot = snapshotManager.createEmpty();

      const fileEntry1: SnapshotFileEntry = {
        path: path.join(tmpDir, "test.txt"),
        url: "automerge:test-url" as any,
        head: ["old-head"] as UrlHeads,
        extension: "txt",
        mimeType: "text/plain",
      };

      const fileEntry2: SnapshotFileEntry = {
        path: path.join(tmpDir, "test.txt"),
        url: "automerge:test-url" as any,
        head: ["new-head"] as UrlHeads,
        extension: "txt",
        mimeType: "text/plain",
      };

      snapshotManager.updateFileEntry(snapshot, "test.txt", fileEntry1);
      snapshotManager.updateFileEntry(snapshot, "test.txt", fileEntry2);

      expect(snapshot.files.get("test.txt")).toEqual(fileEntry2);
      expect(snapshot.files.size).toBe(1);
    });
  });

  describe("removeFileEntry", () => {
    it("should remove file entry", () => {
      const snapshot = snapshotManager.createEmpty();

      const fileEntry: SnapshotFileEntry = {
        path: path.join(tmpDir, "test.txt"),
        url: "automerge:test-url" as any,
        head: ["test-head"] as UrlHeads,
        extension: "txt",
        mimeType: "text/plain",
      };

      snapshotManager.updateFileEntry(snapshot, "test.txt", fileEntry);
      expect(snapshot.files.size).toBe(1);

      snapshotManager.removeFileEntry(snapshot, "test.txt");
      expect(snapshot.files.size).toBe(0);
      expect(snapshot.files.get("test.txt")).toBeUndefined();
    });

    it("should not fail when removing non-existent file", () => {
      const snapshot = snapshotManager.createEmpty();

      snapshotManager.removeFileEntry(snapshot, "nonexistent.txt");
      expect(snapshot.files.size).toBe(0);
    });
  });

  describe("getFilePaths and getDirectoryPaths", () => {
    it("should return all file paths", () => {
      const snapshot = snapshotManager.createEmpty();

      snapshotManager.updateFileEntry(snapshot, "file1.txt", {
        path: path.join(tmpDir, "file1.txt"),
        url: "automerge:url1" as any,
        head: ["head1"] as UrlHeads,
        extension: "txt",
        mimeType: "text/plain",
      });

      snapshotManager.updateFileEntry(snapshot, "file2.txt", {
        path: path.join(tmpDir, "file2.txt"),
        url: "automerge:url2" as any,
        head: ["head2"] as UrlHeads,
        extension: "txt",
        mimeType: "text/plain",
      });

      const filePaths = snapshotManager.getFilePaths(snapshot);
      expect(filePaths.sort()).toEqual(["file1.txt", "file2.txt"]);
    });

    it("should return all directory paths", () => {
      const snapshot = snapshotManager.createEmpty();

      snapshotManager.updateDirectoryEntry(snapshot, "dir1", {
        path: path.join(tmpDir, "dir1"),
        url: "automerge:url1" as any,
        head: ["head1"] as UrlHeads,
        entries: [],
      });

      snapshotManager.updateDirectoryEntry(snapshot, "dir2", {
        path: path.join(tmpDir, "dir2"),
        url: "automerge:url2" as any,
        head: ["head2"] as UrlHeads,
        entries: [],
      });

      const dirPaths = snapshotManager.getDirectoryPaths(snapshot);
      expect(dirPaths.sort()).toEqual(["dir1", "dir2"]);
    });
  });

  describe("isTracked", () => {
    it("should return true for tracked files", () => {
      const snapshot = snapshotManager.createEmpty();

      snapshotManager.updateFileEntry(snapshot, "test.txt", {
        path: path.join(tmpDir, "test.txt"),
        url: "automerge:url" as any,
        head: ["head"] as UrlHeads,
        extension: "txt",
        mimeType: "text/plain",
      });

      expect(snapshotManager.isTracked(snapshot, "test.txt")).toBe(true);
      expect(snapshotManager.isTracked(snapshot, "other.txt")).toBe(false);
    });

    it("should return true for tracked directories", () => {
      const snapshot = snapshotManager.createEmpty();

      snapshotManager.updateDirectoryEntry(snapshot, "subdir", {
        path: path.join(tmpDir, "subdir"),
        url: "automerge:url" as any,
        head: ["head"] as UrlHeads,
        entries: [],
      });

      expect(snapshotManager.isTracked(snapshot, "subdir")).toBe(true);
      expect(snapshotManager.isTracked(snapshot, "other")).toBe(false);
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", () => {
      const snapshot = snapshotManager.createEmpty();

      snapshotManager.updateFileEntry(snapshot, "file1.txt", {
        path: path.join(tmpDir, "file1.txt"),
        url: "automerge:url1" as any,
        head: ["head1"] as UrlHeads,
        extension: "txt",
        mimeType: "text/plain",
      });

      snapshotManager.updateDirectoryEntry(snapshot, "dir1", {
        path: path.join(tmpDir, "dir1"),
        url: "automerge:url2" as any,
        head: ["head2"] as UrlHeads,
        entries: [],
      });

      const stats = snapshotManager.getStats(snapshot);

      expect(stats.files).toBe(1);
      expect(stats.directories).toBe(1);
      expect(stats.timestamp).toBeInstanceOf(Date);
      expect(stats.timestamp.getTime()).toBe(snapshot.timestamp);
    });
  });

  describe("validate", () => {
    it("should validate correct snapshot", () => {
      const snapshot = snapshotManager.createEmpty();

      const validation = snapshotManager.validate(snapshot);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should detect invalid timestamp", () => {
      const snapshot = snapshotManager.createEmpty();
      snapshot.timestamp = 0;

      const validation = snapshotManager.validate(snapshot);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Invalid timestamp");
    });

    it("should detect missing root path", () => {
      const snapshot = snapshotManager.createEmpty();
      snapshot.rootPath = "";

      const validation = snapshotManager.validate(snapshot);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Missing root path");
    });

    it("should detect path conflicts", () => {
      const snapshot = snapshotManager.createEmpty();

      snapshotManager.updateFileEntry(snapshot, "conflict", {
        path: path.join(tmpDir, "conflict"),
        url: "automerge:url1" as any,
        head: ["head1"] as UrlHeads,
        extension: "",
        mimeType: "text/plain",
      });

      snapshotManager.updateDirectoryEntry(snapshot, "conflict", {
        path: path.join(tmpDir, "conflict"),
        url: "automerge:url2" as any,
        head: ["head2"] as UrlHeads,
        entries: [],
      });

      const validation = snapshotManager.validate(snapshot);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain(
        "Path conflict: conflict exists as both file and directory"
      );
    });
  });

  describe("clone", () => {
    it("should create independent copy of snapshot", () => {
      const originalSnapshot = snapshotManager.createEmpty();

      snapshotManager.updateFileEntry(originalSnapshot, "test.txt", {
        path: path.join(tmpDir, "test.txt"),
        url: "automerge:url" as any,
        head: ["head"] as UrlHeads,
        extension: "txt",
        mimeType: "text/plain",
      });

      const clonedSnapshot = snapshotManager.clone(originalSnapshot);

      // Modify clone
      snapshotManager.removeFileEntry(clonedSnapshot, "test.txt");

      // Original should be unchanged
      expect(originalSnapshot.files.size).toBe(1);
      expect(clonedSnapshot.files.size).toBe(0);
    });
  });

  describe("clear", () => {
    it("should clear all data from snapshot", async () => {
      const snapshot = snapshotManager.createEmpty();

      snapshotManager.updateFileEntry(snapshot, "test.txt", {
        path: path.join(tmpDir, "test.txt"),
        url: "automerge:url" as any,
        head: ["head"] as UrlHeads,
        extension: "txt",
        mimeType: "text/plain",
      });

      snapshotManager.updateDirectoryEntry(snapshot, "subdir", {
        path: path.join(tmpDir, "subdir"),
        url: "automerge:url" as any,
        head: ["head"] as UrlHeads,
        entries: [],
      });

      const originalTimestamp = snapshot.timestamp;

      // Add small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 1));

      snapshotManager.clear(snapshot);

      expect(snapshot.files.size).toBe(0);
      expect(snapshot.directories.size).toBe(0);
      expect(snapshot.timestamp).toBeGreaterThan(originalTimestamp);
    });
  });
});
