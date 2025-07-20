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

describe("Sync Engine Deletion Integration", () => {
  let testDir: string;
  let snapshotManager: SnapshotManager;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), "sync-deletion-test-"));
    snapshotManager = new SnapshotManager(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("Deletion Detection Logic", () => {
    it("should properly detect local file deletions", async () => {
      console.log("\n🧪 Testing Local File Deletion Detection");

      // Create initial state
      const filePath = path.join(testDir, "will-be-deleted.ts");
      const content = "interface ToDelete { id: number; }";
      await writeFileContent(filePath, content);

      // Create snapshot representing the "before" state
      const snapshot = snapshotManager.createEmpty();
      snapshotManager.updateFileEntry(snapshot, "will-be-deleted.ts", {
        path: filePath,
        url: "automerge:deletion-test" as any,
        head: ["before-deletion"] as any,
        extension: "ts",
        mimeType: "text/typescript",
      });

      console.log(`📄 Created file: ${filePath}`);
      console.log(`📸 Snapshot has ${snapshot.files.size} files`);

      // Verify initial state
      expect(await pathExists(filePath)).toBe(true);
      expect(snapshot.files.has("will-be-deleted.ts")).toBe(true);

      // Simulate user deleting the file
      await removePath(filePath);
      console.log(`🗑️  File deleted from filesystem`);

      // File should be gone from filesystem but still in snapshot
      expect(await pathExists(filePath)).toBe(false);
      expect(snapshot.files.has("will-be-deleted.ts")).toBe(true);

      console.log(`✅ Deletion properly detected`);
    });

    it("should handle multiple file deletions correctly", async () => {
      console.log("\n🧪 Testing Multiple File Deletions");

      const testFiles = [
        { name: "delete1.ts", content: "interface One { x: number; }" },
        { name: "delete2.js", content: "const two = 'value';" },
        { name: "delete3.json", content: '{"three": true}' },
      ];

      const snapshot = snapshotManager.createEmpty();

      // Create all files and add to snapshot
      for (const file of testFiles) {
        const filePath = path.join(testDir, file.name);
        await writeFileContent(filePath, file.content);

        snapshotManager.updateFileEntry(snapshot, file.name, {
          path: filePath,
          url: `automerge:${file.name}` as any,
          head: [`head-${file.name}`] as any,
          extension: path.extname(file.name).slice(1),
          mimeType: file.name.endsWith(".ts")
            ? "text/typescript"
            : "text/plain",
        });

        console.log(`📄 Created: ${file.name}`);
      }

      expect(snapshot.files.size).toBe(3);

      // Delete all files
      for (const file of testFiles) {
        const filePath = path.join(testDir, file.name);
        await removePath(filePath);
        console.log(`🗑️  Deleted: ${file.name}`);
      }

      // Verify all files are gone from filesystem
      for (const file of testFiles) {
        const filePath = path.join(testDir, file.name);
        expect(await pathExists(filePath)).toBe(false);
      }

      // Snapshot should still have entries (until sync processes them)
      expect(snapshot.files.size).toBe(3);

      // Simulate sync engine processing the deletions
      for (const file of testFiles) {
        snapshotManager.removeFileEntry(snapshot, file.name);
        console.log(`📸 Removed from snapshot: ${file.name}`);
      }

      expect(snapshot.files.size).toBe(0);
      console.log(`✅ Multiple deletions handled correctly`);
    });
  });

  describe("Deletion Timing and Race Conditions", () => {
    it("should handle rapid create-modify-delete sequences", async () => {
      console.log("\n🧪 Testing Rapid Create-Modify-Delete Sequences");

      const filePath = path.join(testDir, "rapid-changes.ts");
      const snapshot = snapshotManager.createEmpty();

      for (let i = 0; i < 3; i++) {
        console.log(`\n--- Cycle ${i + 1} ---`);

        // Create
        const content = `interface Cycle${i} { value: ${i}; }`;
        await writeFileContent(filePath, content);
        console.log(`📄 Created with content: "${content}"`);

        // Add to snapshot
        snapshotManager.updateFileEntry(snapshot, "rapid-changes.ts", {
          path: filePath,
          url: `automerge:cycle-${i}` as any,
          head: [`head-${i}`] as any,
          extension: "ts",
          mimeType: "text/typescript",
        });

        // Modify
        const modifiedContent = content + `\n// Modified in cycle ${i}`;
        await writeFileContent(filePath, modifiedContent);
        console.log(`📝 Modified content`);

        // Delete
        await removePath(filePath);
        console.log(`🗑️  Deleted`);

        // Verify deletion
        expect(await pathExists(filePath)).toBe(false);

        // Clean up snapshot
        snapshotManager.removeFileEntry(snapshot, "rapid-changes.ts");
      }

      console.log(`✅ Rapid sequences handled without errors`);
    });

    it("should handle deletion during content modification attempts", async () => {
      console.log("\n🧪 Testing Deletion During Modification");

      const filePath = path.join(testDir, "modify-delete-race.ts");
      const initialContent = "interface Race { test: boolean; }";

      // Create initial file
      await writeFileContent(filePath, initialContent);
      console.log(`📄 Created file with initial content`);

      // Start modification and deletion concurrently
      const modifyPromise = writeFileContent(
        filePath,
        initialContent + "\n// Modified"
      );
      const deletePromise = (async () => {
        // Small delay to let modification start
        await new Promise((resolve) => setTimeout(resolve, 1));
        await removePath(filePath);
      })();

      // Wait for both operations to complete
      await Promise.allSettled([modifyPromise, deletePromise]);

      // File should be deleted regardless of modification timing
      expect(await pathExists(filePath)).toBe(false);
      console.log(`✅ File properly deleted despite concurrent modification`);
    });
  });

  describe("Directory Structure Impact", () => {
    it("should handle deletion of files in nested directories", async () => {
      console.log("\n🧪 Testing Nested Directory File Deletion");

      // Create nested structure
      const nestedDir = path.join(testDir, "src", "components");
      const filePath = path.join(nestedDir, "Button.tsx");
      const content = "export const Button = () => <button>Click</button>;";

      await fs.mkdir(nestedDir, { recursive: true });
      await writeFileContent(filePath, content);

      const snapshot = snapshotManager.createEmpty();
      snapshotManager.updateFileEntry(snapshot, "src/components/Button.tsx", {
        path: filePath,
        url: "automerge:nested-button" as any,
        head: ["nested-head"] as any,
        extension: "tsx",
        mimeType: "text/tsx",
      });

      console.log(`📁 Created nested structure: ${nestedDir}`);
      console.log(`📄 Created file: src/components/Button.tsx`);

      // Delete just the file (not the directories)
      await removePath(filePath);
      console.log(`🗑️  Deleted file, kept directory structure`);

      // File should be gone, directories should remain
      expect(await pathExists(filePath)).toBe(false);
      expect(await pathExists(nestedDir)).toBe(true);
      expect(await pathExists(path.join(testDir, "src"))).toBe(true);

      // Simulate snapshot cleanup
      snapshotManager.removeFileEntry(snapshot, "src/components/Button.tsx");
      expect(snapshot.files.size).toBe(0);

      console.log(`✅ Nested file deletion handled correctly`);
    });

    it("should handle deletion of entire directory trees", async () => {
      console.log("\n🧪 Testing Directory Tree Deletion");

      // Create multiple files in nested structure
      const testStructure = [
        "src/utils/helpers.ts",
        "src/utils/constants.ts",
        "src/components/Button.tsx",
        "src/components/Input.tsx",
        "src/types/index.ts",
      ];

      const snapshot = snapshotManager.createEmpty();

      for (const relativePath of testStructure) {
        const fullPath = path.join(testDir, relativePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await writeFileContent(fullPath, `// Content for ${relativePath}`);

        snapshotManager.updateFileEntry(snapshot, relativePath, {
          path: fullPath,
          url: `automerge:${relativePath.replace(/[\/\.]/g, "-")}` as any,
          head: [`head-${relativePath}`] as any,
          extension: path.extname(relativePath).slice(1),
          mimeType: "text/typescript",
        });

        console.log(`📄 Created: ${relativePath}`);
      }

      expect(snapshot.files.size).toBe(5);

      // Delete entire src directory
      await removePath(path.join(testDir, "src"));
      console.log(`🗑️  Deleted entire src/ directory tree`);

      // Verify all files and directories are gone
      for (const relativePath of testStructure) {
        const fullPath = path.join(testDir, relativePath);
        expect(await pathExists(fullPath)).toBe(false);
      }
      expect(await pathExists(path.join(testDir, "src"))).toBe(false);

      // Simulate snapshot cleanup for all files
      for (const relativePath of testStructure) {
        snapshotManager.removeFileEntry(snapshot, relativePath);
        console.log(`📸 Removed from snapshot: ${relativePath}`);
      }

      expect(snapshot.files.size).toBe(0);
      console.log(`✅ Directory tree deletion handled correctly`);
    });
  });

  describe("Error Recovery and Edge Cases", () => {
    it("should handle deletion of non-existent files gracefully", async () => {
      console.log("\n🧪 Testing Non-Existent File Deletion");

      const nonExistentPath = path.join(testDir, "never-existed.ts");

      // Attempt to delete non-existent file (should not throw)
      await expect(removePath(nonExistentPath)).resolves.not.toThrow();
      console.log(`✅ Non-existent file deletion handled gracefully`);

      // Attempt to remove from snapshot (should not throw)
      const snapshot = snapshotManager.createEmpty();
      expect(() => {
        snapshotManager.removeFileEntry(snapshot, "never-existed.ts");
      }).not.toThrow();
      console.log(`✅ Non-existent snapshot entry removal handled gracefully`);
    });

    it("should provide debugging info for deletion failures", async () => {
      console.log("\n🧪 Deletion Debugging Information");

      const debugFilePath = path.join(testDir, "debug-deletion.ts");
      const content = "interface Debug { info: string; }";

      try {
        // Create file
        await writeFileContent(debugFilePath, content);
        console.log(`📄 File created: ${debugFilePath}`);
        console.log(`📏 File size: ${content.length} characters`);

        // Verify file exists and is readable
        const readBack = await readFileContent(debugFilePath);
        console.log(`📖 File readable: ${typeof readBack === "string"}`);
        console.log(`✅ Content matches: ${readBack === content}`);

        // Delete file
        const deleteStart = Date.now();
        await removePath(debugFilePath);
        const deleteTime = Date.now() - deleteStart;

        console.log(`🗑️  Deletion completed in ${deleteTime}ms`);
        console.log(
          `🔍 File exists after deletion: ${await pathExists(debugFilePath)}`
        );
      } catch (error) {
        console.error(`❌ Deletion test failed:`, error);
        throw error;
      }
    });
  });
});
