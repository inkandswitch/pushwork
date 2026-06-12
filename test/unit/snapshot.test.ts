import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import * as fc from "fast-check";
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

    it("returns null (not a throw) for corrupt snapshot.json", async () => {
      // The load() catch path: a half-written or corrupted snapshot must
      // degrade to "no snapshot" rather than crash every subsequent command.
      await fs.mkdir(path.join(tmpDir, ".pushwork"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, ".pushwork", "snapshot.json"),
        "{ not: valid json !!!"
      );
      expect(await snapshotManager.load()).toBeNull();
    });

    it("property: save/load round-trips arbitrary snapshots exactly", async () => {
      // Maps serialize to JSON arrays-of-pairs and back; optional fields
      // (contentHash, rootDirectoryUrl) must survive. A lossy round-trip
      // here corrupts change detection for every subsequent sync.
      const relPath = fc
        .array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 3 })
        .map((segs) => segs.join("/"));
      const head = fc.array(fc.stringMatching(/^[a-zA-Z0-9]{4,12}$/), {
        minLength: 1,
        maxLength: 2,
      });
      const fileEntry = fc.record(
        {
          url: fc.stringMatching(/^automerge:[a-zA-Z0-9]{8,16}$/),
          head,
          extension: fc.constantFrom("txt", "ts", "js", ""),
          mimeType: fc.constantFrom("text/plain", "application/json"),
          contentHash: fc.option(fc.stringMatching(/^[0-9a-f]{64}$/), {
            nil: undefined,
          }),
        },
        { requiredKeys: ["url", "head", "extension", "mimeType"] }
      );
      const dirEntry = fc.record({
        url: fc.stringMatching(/^automerge:[a-zA-Z0-9]{8,16}$/),
        head,
        entries: fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { maxLength: 3 }),
      });

      await fc.assert(
        fc.asyncProperty(
          fc.dictionary(relPath, fileEntry, { maxKeys: 5 }),
          fc.dictionary(relPath, dirEntry, { maxKeys: 3 }),
          async (files, dirs) => {
            const snapshot = snapshotManager.createEmpty();
            for (const [p, e] of Object.entries(files)) {
              snapshotManager.updateFileEntry(snapshot, p, {
                ...(e as any),
                path: path.join(tmpDir, p),
              } as SnapshotFileEntry);
            }
            for (const [p, e] of Object.entries(dirs)) {
              snapshotManager.updateDirectoryEntry(snapshot, p, {
                ...(e as any),
                path: path.join(tmpDir, p),
              } as SnapshotDirectoryEntry);
            }

            await snapshotManager.save(snapshot);
            const loaded = await snapshotManager.load();

            expect(loaded).not.toBeNull();
            expect(loaded!.timestamp).toBe(snapshot.timestamp);
            expect(loaded!.rootDirectoryUrl).toBe(snapshot.rootDirectoryUrl);
            expect(Object.fromEntries(loaded!.files)).toEqual(
              Object.fromEntries(snapshot.files)
            );
            expect(Object.fromEntries(loaded!.directories)).toEqual(
              Object.fromEntries(snapshot.directories)
            );
          }
        ),
        { numRuns: 25 } // each run hits disk
      );
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
      await new Promise((resolve) => setTimeout(resolve, 10));

      snapshotManager.clear(snapshot);

      expect(snapshot.files.size).toBe(0);
      expect(snapshot.directories.size).toBe(0);
      expect(snapshot.timestamp).toBeGreaterThan(originalTimestamp);
    });
  });
});
