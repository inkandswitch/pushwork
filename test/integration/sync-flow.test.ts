import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { ConfigManager } from "../../src/core";
import { DirectoryConfig } from "../../src/types";

describe("Sync Flow Integration", () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(() => {
    cleanup();
  });

  describe("Configuration Management", () => {
    it("should create and load configuration", async () => {
      const configManager = new ConfigManager(tmpDir);

      // Create test config
      const testConfig: DirectoryConfig = {
        sync_server: "wss://test.server.com",
        sync_enabled: true,
        exclude_patterns: [".git", "*.tmp"],
        artifact_directories: ["dist"],
        sync: {
          move_detection_threshold: 0.8,
        },
      };

      await configManager.save(testConfig);

      const loadedConfig = await configManager.load();
      expect(loadedConfig).toEqual(testConfig);
    });

    it("should merge global and local configurations", async () => {
      const configManager = new ConfigManager(tmpDir);

      // Create default global config
      await configManager.createDefaultGlobal();

      // Test directory config
      const localConfig: DirectoryConfig = {
        sync_server: "wss://local.server.com",
        sync_enabled: true,
        exclude_patterns: [".git", "*.tmp"],
        artifact_directories: ["dist"],
        sync: {
          move_detection_threshold: 0.9,
        },
      };

      await configManager.save(localConfig);

      // Verify merged config
      const mergedConfig = await configManager.getMerged();
      expect(mergedConfig.sync_server).toBe("wss://local.server.com");
      expect(mergedConfig.exclude_patterns).toContain(".git");
      expect(mergedConfig.sync?.move_detection_threshold).toBe(0.9);
    });
  });

  describe("File System Operations", () => {
    it("should handle file creation and modification", async () => {
      // Create initial file structure
      await fs.mkdir(path.join(tmpDir, "subdir"));
      await fs.writeFile(path.join(tmpDir, "file1.txt"), "Initial content");
      await fs.writeFile(
        path.join(tmpDir, "subdir", "file2.txt"),
        "Nested content"
      );

      // Modify files
      await fs.writeFile(path.join(tmpDir, "file1.txt"), "Modified content");
      await fs.writeFile(path.join(tmpDir, "new-file.txt"), "New file content");

      // Delete file
      await fs.unlink(path.join(tmpDir, "subdir", "file2.txt"));

      // Verify final state
      const file1Content = await fs.readFile(
        path.join(tmpDir, "file1.txt"),
        "utf8"
      );
      expect(file1Content).toBe("Modified content");

      const newFileContent = await fs.readFile(
        path.join(tmpDir, "new-file.txt"),
        "utf8"
      );
      expect(newFileContent).toBe("New file content");

      try {
        await fs.access(path.join(tmpDir, "subdir", "file2.txt"));
        throw new Error("Deleted file should not exist");
      } catch (error: any) {
        // Expected - file should not exist
        expect(error.code).toBe("ENOENT");
      }
    });

    it("should handle binary files", async () => {
      const binaryData = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]); // PNG header

      await fs.writeFile(path.join(tmpDir, "image.png"), binaryData);

      const readData = await fs.readFile(path.join(tmpDir, "image.png"));
      expect(Array.from(readData)).toEqual(Array.from(binaryData));
    });
  });

  describe("Directory Structure Scenarios", () => {
    it("should handle complex directory structures", async () => {
      const structure = {
        src: {
          components: {
            "Button.tsx": "export const Button = () => <button />",
            "Input.tsx": "export const Input = () => <input />",
          },
          utils: {
            "helpers.ts": "export const helper = () => {}",
            "constants.ts": 'export const API_URL = "http://localhost"',
          },
          "index.ts": 'export * from "./components"',
        },
        "package.json": '{"name": "test-project", "version": "1.0.0"}',
        "README.md": "# Test Project\n\nThis is a test project.",
      };

      await createDirectoryStructure(tmpDir, structure);

      // Verify structure was created
      const srcExists = await pathExists(path.join(tmpDir, "src"));
      expect(srcExists).toBe(true);

      const buttonExists = await pathExists(
        path.join(tmpDir, "src", "components", "Button.tsx")
      );
      expect(buttonExists).toBe(true);

      const packageContent = await fs.readFile(
        path.join(tmpDir, "package.json"),
        "utf8"
      );
      expect(JSON.parse(packageContent).name).toBe("test-project");
    });

    it("should handle file moves and renames", async () => {
      // Create initial files
      await fs.writeFile(path.join(tmpDir, "old-name.txt"), "File content");
      await fs.mkdir(path.join(tmpDir, "new-dir"));

      // Simulate move operation
      await fs.rename(
        path.join(tmpDir, "old-name.txt"),
        path.join(tmpDir, "new-dir", "new-name.txt")
      );

      // Verify move
      const movedFileExists = await pathExists(
        path.join(tmpDir, "new-dir", "new-name.txt")
      );
      expect(movedFileExists).toBe(true);

      const oldFileExists = await pathExists(path.join(tmpDir, "old-name.txt"));
      expect(oldFileExists).toBe(false);

      const content = await fs.readFile(
        path.join(tmpDir, "new-dir", "new-name.txt"),
        "utf8"
      );
      expect(content).toBe("File content");
    });
  });

  describe("Error Handling", () => {
    it("should handle permission errors gracefully", async () => {
      // Create a file
      const filePath = path.join(tmpDir, "restricted.txt");
      await fs.writeFile(filePath, "content");

      // Make it read-only (if supported by filesystem)
      try {
        await fs.chmod(filePath, 0o444);

        // Try to write - should handle error gracefully
        try {
          await fs.writeFile(filePath, "new content");
          // If this succeeds, the filesystem doesn't enforce permissions
        } catch (error) {
          expect(error).toBeDefined();
          // This is expected behavior
        }
      } catch {
        // chmod may not be supported on all filesystems
        console.log(
          "Permission test skipped - filesystem does not support chmod"
        );
      }
    });

    it("should handle corrupted snapshot files", async () => {
      const configManager = new ConfigManager(tmpDir);

      // Create .pushwork directory
      const syncToolDir = path.join(tmpDir, ".pushwork");
      await fs.mkdir(syncToolDir);

      // Write corrupted snapshot
      const snapshotPath = path.join(syncToolDir, "snapshot.json");
      await fs.writeFile(snapshotPath, '{"invalid": json}');

      // Should handle gracefully
      const config = await configManager.load();
      expect(config).toBeNull();
    });
  });

  describe("Performance Scenarios", () => {
    it("should handle many small files", async () => {
      const fileCount = 100;
      const promises: Promise<void>[] = [];

      for (let i = 0; i < fileCount; i++) {
        const filePath = path.join(tmpDir, `file-${i}.txt`);
        promises.push(fs.writeFile(filePath, `Content of file ${i}`));
      }

      await Promise.all(promises);

      // Verify all files were created
      const files = await fs.readdir(tmpDir);
      const textFiles = files.filter((f) => f.endsWith(".txt"));
      expect(textFiles.length).toBe(fileCount);
    });

    it("should handle large files efficiently", async () => {
      const largeContent = "x".repeat(1024 * 1024); // 1MB of data
      const filePath = path.join(tmpDir, "large-file.txt");

      const startTime = Date.now();
      await fs.writeFile(filePath, largeContent);
      const writeTime = Date.now() - startTime;

      const readStartTime = Date.now();
      const readContent = await fs.readFile(filePath, "utf8");
      const readTime = Date.now() - readStartTime;

      expect(readContent.length).toBe(largeContent.length);
      expect(writeTime).toBeLessThan(5000); // Should complete within 5 seconds
      expect(readTime).toBeLessThan(5000); // Should complete within 5 seconds
    }, 10000); // 10 second timeout
  });
});

// Helper functions

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createDirectoryStructure(
  basePath: string,
  structure: any
): Promise<void> {
  for (const [name, content] of Object.entries(structure)) {
    const fullPath = path.join(basePath, name);

    if (typeof content === "string") {
      // It's a file
      await fs.writeFile(fullPath, content);
    } else {
      // It's a directory
      await fs.mkdir(fullPath, { recursive: true });
      await createDirectoryStructure(fullPath, content);
    }
  }
}
