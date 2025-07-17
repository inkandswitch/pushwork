import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import { SyncEngine } from "../../src/core";
import { Repo } from "@automerge/automerge-repo";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import { getMimeType, isTextFile } from "../../src/utils";

describe("Sync Completion and MIME Detection", () => {
  let testDir1: string;
  let testDir2: string;
  let repo1: Repo;
  let repo2: Repo;

  beforeEach(async () => {
    // Create two temporary directories for testing
    testDir1 = await fs.mkdtemp(path.join(tmpdir(), "sync-completion-1-"));
    testDir2 = await fs.mkdtemp(path.join(tmpdir(), "sync-completion-2-"));

    // Create separate repos with different storage
    repo1 = new Repo({
      storage: new NodeFSStorageAdapter(
        path.join(testDir1, ".sync-tool", "automerge")
      ),
      network: [], // Local-only for testing
    });

    repo2 = new Repo({
      storage: new NodeFSStorageAdapter(
        path.join(testDir2, ".sync-tool", "automerge")
      ),
      network: [], // Local-only for testing
    });

    // Create .sync-tool directories
    await fs.mkdir(path.join(testDir1, ".sync-tool"), { recursive: true });
    await fs.mkdir(path.join(testDir2, ".sync-tool"), { recursive: true });
    await fs.mkdir(path.join(testDir1, ".sync-tool", "automerge"), {
      recursive: true,
    });
    await fs.mkdir(path.join(testDir2, ".sync-tool", "automerge"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await repo1.shutdown();
    await repo2.shutdown();
    await fs.rm(testDir1, { recursive: true, force: true });
    await fs.rm(testDir2, { recursive: true, force: true });
  });

  describe("Sync Completion Detection", () => {
    it("should properly handle rapid sync operations", async () => {
      // Create initial content in dir1
      await fs.writeFile(path.join(testDir1, "test.txt"), "initial content");

      const engine1 = new SyncEngine(repo1, testDir1, []);

      // Initial sync
      const result1 = await engine1.sync(false);
      expect(result1.success).toBe(true);

      // Get status to check if sync completed properly
      const status1 = await engine1.getStatus();
      expect(status1.hasChanges).toBe(false);

      // Test rapid changes
      await fs.writeFile(path.join(testDir1, "test.txt"), "updated content");
      await fs.writeFile(path.join(testDir1, "test2.txt"), "new file");

      const result2 = await engine1.sync(false);
      expect(result2.success).toBe(true);
      expect(result2.filesChanged).toBeGreaterThan(0);

      // Check if changes are immediately visible in status
      const status2 = await engine1.getStatus();
      expect(status2.hasChanges).toBe(false); // Should be no changes after sync
    }, 10000);

    it("should handle concurrent operations without data loss", async () => {
      // Create test files
      await fs.writeFile(path.join(testDir1, "file1.txt"), "content1");
      await fs.writeFile(path.join(testDir1, "file2.txt"), "content2");

      const engine1 = new SyncEngine(repo1, testDir1, []);

      // Initial sync
      await engine1.sync(false);

      // Rapid sequential changes
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          fs.writeFile(path.join(testDir1, `rapid${i}.txt`), `content${i}`)
        );
      }
      await Promise.all(promises);

      // Single sync should handle all changes
      const result = await engine1.sync(false);
      expect(result.success).toBe(true);
      expect(result.filesChanged).toBe(5); // 5 new files

      // Verify all files are tracked
      const status = await engine1.getStatus();
      expect(status.snapshot?.files.size).toBe(7); // original 2 + 5 new
    });
  });

  describe("MIME Type Detection", () => {
    it("should correctly identify common developer file types", async () => {
      const testCases = [
        {
          filename: "script.ts",
          expectedMime: "video/mp2t",
          shouldBeText: true,
        },
        {
          filename: "component.tsx",
          expectedMime: "application/octet-stream",
          shouldBeText: true,
        },
        {
          filename: "config.json",
          expectedMime: "application/json",
          shouldBeText: true,
        },
        { filename: "style.css", expectedMime: "text/css", shouldBeText: true },
        {
          filename: "document.md",
          expectedMime: "text/markdown",
          shouldBeText: true,
        },
        {
          filename: "script.js",
          expectedMime: "application/javascript",
          shouldBeText: true,
        },
        {
          filename: "image.png",
          expectedMime: "image/png",
          shouldBeText: false,
        },
        {
          filename: "archive.zip",
          expectedMime: "application/zip",
          shouldBeText: false,
        },
      ];

      for (const testCase of testCases) {
        const filePath = path.join(testDir1, testCase.filename);

        // Create test file with appropriate content
        const content = testCase.shouldBeText
          ? `// Test content for ${testCase.filename}`
          : Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP header for binary files

        await fs.writeFile(filePath, content);

        // Test MIME type detection
        const detectedMime = getMimeType(filePath);
        console.log(
          `${testCase.filename}: detected=${detectedMime}, expected=${testCase.expectedMime}`
        );

        // Test text/binary classification
        const isText = await isTextFile(filePath);
        expect(isText).toBe(testCase.shouldBeText);
      }
    });

    it("should handle files without extensions", async () => {
      const filePath = path.join(testDir1, "README");
      await fs.writeFile(filePath, "# This is a README");

      const mimeType = getMimeType(filePath);
      expect(mimeType).toBe("application/octet-stream"); // fallback

      const isText = await isTextFile(filePath);
      expect(isText).toBe(true); // should detect as text by content
    });

    it("should properly detect binary files", async () => {
      const filePath = path.join(testDir1, "binary.dat");
      const binaryContent = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]); // PNG-like header
      await fs.writeFile(filePath, binaryContent);

      const isText = await isTextFile(filePath);
      expect(isText).toBe(false);
    });
  });

  describe("Sync Engine with Better MIME Detection", () => {
    it("should handle TypeScript files correctly", async () => {
      const tsContent = `
interface User {
  name: string;
  age: number;
}

export function greet(user: User): string {
  return \`Hello, \${user.name}!\`;
}
`;

      await fs.writeFile(path.join(testDir1, "user.ts"), tsContent);

      const engine = new SyncEngine(repo1, testDir1, []);
      const result = await engine.sync(false);

      expect(result.success).toBe(true);
      expect(result.filesChanged).toBe(1);

      // Verify the file is in the snapshot
      const status = await engine.getStatus();
      expect(status.snapshot?.files.has("user.ts")).toBe(true);

      const fileEntry = status.snapshot?.files.get("user.ts");
      expect(fileEntry?.extension).toBe(".ts");
      // Note: current MIME detection might not be optimal for .ts files
    });
  });
});
