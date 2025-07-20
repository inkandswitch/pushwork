import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import {
  readFileContent,
  writeFileContent,
  removePath,
  pathExists,
} from "../../src/utils";
import { SnapshotManager } from "../../src/core/snapshot";
import { ChangeDetector } from "../../src/core/change-detection";
import { ChangeType } from "../../src/types";

describe("File Deletion Behavior", () => {
  let testDir: string;
  let snapshotManager: SnapshotManager;
  let changeDetector: ChangeDetector;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), "deletion-test-"));
    snapshotManager = new SnapshotManager(testDir);
    // Create a minimal change detector for testing (without Automerge repo)
    changeDetector = new ChangeDetector(null as any, testDir, []);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("Basic File Deletion", () => {
    it("should read TypeScript files correctly before deletion", async () => {
      const tsFile = path.join(testDir, "component.ts");
      const content = "interface User { name: string; }";
      await writeFileContent(tsFile, content);

      const result = await readFileContent(tsFile);
      expect(typeof result).toBe("string");
      expect(result).toBe(content);
    });

    it("should handle file deletion through removePath", async () => {
      const filePath = path.join(testDir, "test.txt");
      await writeFileContent(filePath, "test content");

      expect(await pathExists(filePath)).toBe(true);

      await removePath(filePath);

      expect(await pathExists(filePath)).toBe(false);
    });

    it("should handle directory deletion through removePath", async () => {
      const dirPath = path.join(testDir, "subdir");
      const filePath = path.join(dirPath, "file.txt");

      await fs.mkdir(dirPath);
      await writeFileContent(filePath, "content");

      expect(await pathExists(dirPath)).toBe(true);
      expect(await pathExists(filePath)).toBe(true);

      await removePath(dirPath);

      expect(await pathExists(dirPath)).toBe(false);
      expect(await pathExists(filePath)).toBe(false);
    });
  });

  describe("Snapshot Deletion Behavior", () => {
    it("should properly remove files from snapshot", () => {
      const snapshot = snapshotManager.createEmpty();

      // Add a file to snapshot
      snapshotManager.updateFileEntry(snapshot, "test.txt", {
        path: path.join(testDir, "test.txt"),
        url: "automerge:test-url" as any,
        head: ["test-head"] as any,
        extension: "txt",
        mimeType: "text/plain",
      });

      expect(snapshot.files.has("test.txt")).toBe(true);

      // Remove file from snapshot
      snapshotManager.removeFileEntry(snapshot, "test.txt");

      expect(snapshot.files.has("test.txt")).toBe(false);
      expect(snapshot.files.size).toBe(0);
    });

    it("should handle removing non-existent files gracefully", () => {
      const snapshot = snapshotManager.createEmpty();

      // Should not throw when removing non-existent file
      expect(() => {
        snapshotManager.removeFileEntry(snapshot, "nonexistent.txt");
      }).not.toThrow();

      expect(snapshot.files.size).toBe(0);
    });
  });

  describe("Deletion Scenario Simulation", () => {
    it("should simulate local file deletion scenario", async () => {
      // Create a file
      const filePath = path.join(testDir, "deleteme.txt");
      const content = "This file will be deleted";
      await writeFileContent(filePath, content);

      // Verify file exists
      expect(await pathExists(filePath)).toBe(true);
      const readContent = await readFileContent(filePath);
      expect(readContent).toBe(content);

      // Create snapshot with this file
      const snapshot = snapshotManager.createEmpty();
      snapshotManager.updateFileEntry(snapshot, "deleteme.txt", {
        path: filePath,
        url: "automerge:delete-test" as any,
        head: ["initial-head"] as any,
        extension: "txt",
        mimeType: "text/plain",
      });

      // Simulate local deletion (user deletes file)
      await removePath(filePath);

      // Verify file is gone
      expect(await pathExists(filePath)).toBe(false);

      // Snapshot should still have the file entry (until sync processes the deletion)
      expect(snapshot.files.has("deleteme.txt")).toBe(true);

      // Simulate sync engine processing the deletion
      snapshotManager.removeFileEntry(snapshot, "deleteme.txt");

      // Now snapshot should not have the file
      expect(snapshot.files.has("deleteme.txt")).toBe(false);
    });

    it("should handle rapid create-delete cycles", async () => {
      const filePath = path.join(testDir, "rapid.txt");

      // Rapid create-delete cycle
      for (let i = 0; i < 5; i++) {
        await writeFileContent(filePath, `content ${i}`);
        expect(await pathExists(filePath)).toBe(true);

        await removePath(filePath);
        expect(await pathExists(filePath)).toBe(false);
      }
    });

    it("should handle deletion of different file types", async () => {
      const testFiles = [
        { name: "text.txt", content: "text content" },
        { name: "code.ts", content: "interface Test { x: number; }" },
        { name: "config.json", content: '{"key": "value"}' },
        { name: "binary.bin", content: new Uint8Array([0x00, 0x01, 0x02]) },
      ];

      // Create all files
      for (const file of testFiles) {
        const filePath = path.join(testDir, file.name);
        await writeFileContent(filePath, file.content);
        expect(await pathExists(filePath)).toBe(true);
      }

      // Delete all files
      for (const file of testFiles) {
        const filePath = path.join(testDir, file.name);
        await removePath(filePath);
        expect(await pathExists(filePath)).toBe(false);
      }
    });
  });

  describe("Edge Cases and Error Conditions", () => {
    it("should handle deletion of files with special characters", async () => {
      const specialFiles = [
        "file with spaces.txt",
        "file-with-dashes.txt",
        "file_with_underscores.txt",
        "file.with.multiple.dots.txt",
      ];

      for (const fileName of specialFiles) {
        const filePath = path.join(testDir, fileName);
        await writeFileContent(filePath, "test content");
        expect(await pathExists(filePath)).toBe(true);

        await removePath(filePath);
        expect(await pathExists(filePath)).toBe(false);
      }
    });

    it("should handle deletion of nested directory structures", async () => {
      // Create nested structure
      const nestedPath = path.join(testDir, "level1", "level2", "level3");
      const filePath = path.join(nestedPath, "deep.txt");

      await fs.mkdir(nestedPath, { recursive: true });
      await writeFileContent(filePath, "deep content");

      expect(await pathExists(filePath)).toBe(true);

      // Delete entire structure from top level
      await removePath(path.join(testDir, "level1"));

      expect(await pathExists(path.join(testDir, "level1"))).toBe(false);
      expect(await pathExists(filePath)).toBe(false);
    });

    it("should handle concurrent deletion attempts", async () => {
      const filePath = path.join(testDir, "concurrent.txt");
      await writeFileContent(filePath, "content");

      // Multiple deletion attempts (should not cause errors)
      const deletions = [
        removePath(filePath),
        removePath(filePath),
        removePath(filePath),
      ];

      await Promise.all(deletions);

      expect(await pathExists(filePath)).toBe(false);
    });
  });

  describe("Debug Information", () => {
    it("should provide detailed info about deletion behavior", async () => {
      console.log("\n=== Deletion Behavior Debug Info ===");

      const filePath = path.join(testDir, "debug.txt");
      const content = "Debug test content";

      console.log(`Test directory: ${testDir}`);
      console.log(`File path: ${filePath}`);

      // Create file
      await writeFileContent(filePath, content);
      console.log(`✅ File created successfully`);

      // Verify file content
      const readBack = await readFileContent(filePath);
      console.log(`✅ File content verified: "${readBack}"`);

      // Delete file
      await removePath(filePath);
      console.log(`✅ File deleted successfully`);

      // Verify deletion
      const exists = await pathExists(filePath);
      console.log(`✅ File deletion verified: exists=${exists}`);

      console.log("=== End Debug Info ===\n");
    });
  });
});
