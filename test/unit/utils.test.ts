import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import {
  pathExists,
  getFileSystemEntry,
  isTextFile,
  readFileContent,
  writeFileContent,
  ensureDirectoryExists,
  removePath,
  listDirectory,
  copyFile,
  movePath,
  calculateContentHash,
  getMimeType,
  getFileExtension,
  normalizePath,
  getRelativePath,
} from "../../src/utils/fs";
import { FileType } from "../../src/types";

describe("File System Utilities", () => {
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

  describe("pathExists", () => {
    it("should return true for existing files", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "test content");

      expect(await pathExists(filePath)).toBe(true);
    });

    it("should return false for non-existing files", async () => {
      const filePath = path.join(tmpDir, "nonexistent.txt");

      expect(await pathExists(filePath)).toBe(false);
    });

    it("should return true for existing directories", async () => {
      expect(await pathExists(tmpDir)).toBe(true);
    });
  });

  describe("getFileSystemEntry", () => {
    it("should return metadata for files", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "test content");

      const entry = await getFileSystemEntry(filePath);

      expect(entry).not.toBeNull();
      expect(entry?.path).toBe(filePath);
      expect(entry?.type).toBe(FileType.TEXT);
      expect(entry?.size).toBe(12); // 'test content'.length
      expect(entry?.mtime).toBeDefined();
      expect(entry?.mtime.getTime()).toBeGreaterThan(0);
      expect(typeof entry?.mtime.getTime()).toBe("number");
    });

    it("should return metadata for directories", async () => {
      const dirPath = path.join(tmpDir, "subdir");
      await fs.mkdir(dirPath);

      const entry = await getFileSystemEntry(dirPath);

      expect(entry).not.toBeNull();
      expect(entry?.path).toBe(dirPath);
      expect(entry?.type).toBe(FileType.DIRECTORY);
    });

    it("should return null for non-existing paths", async () => {
      const entry = await getFileSystemEntry(path.join(tmpDir, "nonexistent"));
      expect(entry).toBeNull();
    });
  });

  describe("isTextFile", () => {
    it("should detect text files by extension", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "text content");

      expect(await isTextFile(filePath)).toBe(true);
    });

    it("should detect JSON files as text", async () => {
      const filePath = path.join(tmpDir, "test.json");
      await fs.writeFile(filePath, '{"key": "value"}');

      expect(await isTextFile(filePath)).toBe(true);
    });

    it("should detect binary files by content", async () => {
      const filePath = path.join(tmpDir, "test.bin");
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      await fs.writeFile(filePath, binaryContent);

      expect(await isTextFile(filePath)).toBe(false);
    });
  });

  describe("readFileContent", () => {
    it("should read text files as strings", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      const content = "Hello, world!";
      await fs.writeFile(filePath, content);

      const result = await readFileContent(filePath);

      expect(typeof result).toBe("string");
      expect(result).toBe(content);
    });

    it("should read TypeScript files as strings", async () => {
      const filePath = path.join(tmpDir, "component.ts");
      const content = "interface User { name: string; age: number; }";
      await fs.writeFile(filePath, content);

      const result = await readFileContent(filePath);

      expect(typeof result).toBe("string");
      expect(result).toBe(content);
    });

    it("should read TSX files as strings", async () => {
      const filePath = path.join(tmpDir, "Component.tsx");
      const content = "export const App = () => <div>Hello World</div>;";
      await fs.writeFile(filePath, content);

      const result = await readFileContent(filePath);

      expect(typeof result).toBe("string");
      expect(result).toBe(content);
    });

    it("should read Vue files as strings", async () => {
      const filePath = path.join(tmpDir, "App.vue");
      const content = "<template><div>{{ message }}</div></template>";
      await fs.writeFile(filePath, content);

      const result = await readFileContent(filePath);

      expect(typeof result).toBe("string");
      expect(result).toBe(content);
    });

    it("should read SCSS files as strings", async () => {
      const filePath = path.join(tmpDir, "styles.scss");
      const content = "$primary: #007bff; .btn { color: $primary; }";
      await fs.writeFile(filePath, content);

      const result = await readFileContent(filePath);

      expect(typeof result).toBe("string");
      expect(result).toBe(content);
    });

    it("should read binary files as Uint8Array", async () => {
      const filePath = path.join(tmpDir, "test.bin");
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      await fs.writeFile(filePath, binaryContent);

      const result = await readFileContent(filePath);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result as Uint8Array)).toEqual([
        0x00, 0x01, 0x02, 0x03,
      ]);
    });
  });

  describe("writeFileContent", () => {
    it("should write string content to files", async () => {
      const filePath = path.join(tmpDir, "output.txt");
      const content = "Test content";

      await writeFileContent(filePath, content);

      const written = await fs.readFile(filePath, "utf8");
      expect(written).toBe(content);
    });

    it("should write binary content to files", async () => {
      const filePath = path.join(tmpDir, "output.bin");
      const content = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

      await writeFileContent(filePath, content);

      const written = await fs.readFile(filePath);
      expect(Array.from(written)).toEqual([0x00, 0x01, 0x02, 0x03]);
    });

    it("should create directories if they don't exist", async () => {
      const filePath = path.join(tmpDir, "nested", "deep", "file.txt");

      await writeFileContent(filePath, "content");

      expect(await pathExists(filePath)).toBe(true);
      expect(await fs.readFile(filePath, "utf8")).toBe("content");
    });
  });

  describe("ensureDirectoryExists", () => {
    it("should create directories recursively", async () => {
      const dirPath = path.join(tmpDir, "nested", "deep", "directory");

      await ensureDirectoryExists(dirPath);

      expect(await pathExists(dirPath)).toBe(true);
      const stats = await fs.stat(dirPath);
      expect(stats.isDirectory()).toBe(true);
    });

    it("should not fail if directory already exists", async () => {
      await ensureDirectoryExists(tmpDir);
      await ensureDirectoryExists(tmpDir); // Should not throw

      expect(await pathExists(tmpDir)).toBe(true);
    });
  });

  describe("removePath", () => {
    it("should remove files", async () => {
      const filePath = path.join(tmpDir, "toremove.txt");
      await fs.writeFile(filePath, "content");

      await removePath(filePath);

      expect(await pathExists(filePath)).toBe(false);
    });

    it("should remove directories recursively", async () => {
      const dirPath = path.join(tmpDir, "toremove");
      const filePath = path.join(dirPath, "file.txt");
      await fs.mkdir(dirPath);
      await fs.writeFile(filePath, "content");

      await removePath(dirPath);

      expect(await pathExists(dirPath)).toBe(false);
    });

    it("should not fail if path doesn't exist", async () => {
      const nonExistentPath = path.join(tmpDir, "nonexistent");

      await removePath(nonExistentPath); // Should not throw

      expect(await pathExists(nonExistentPath)).toBe(false);
    });
  });

  describe("listDirectory", () => {
    beforeEach(async () => {
      // Create test directory structure
      await fs.mkdir(path.join(tmpDir, "subdir"));
      await fs.writeFile(path.join(tmpDir, "file1.txt"), "content1");
      await fs.writeFile(path.join(tmpDir, "file2.txt"), "content2");
      await fs.writeFile(path.join(tmpDir, "subdir", "file3.txt"), "content3");
    });

    it("should list directory contents non-recursively", async () => {
      const entries = await listDirectory(tmpDir, false);

      const names = entries.map((e) => path.basename(e.path)).sort();
      expect(names).toEqual(["file1.txt", "file2.txt", "subdir"]);
    });

    it("should list directory contents recursively", async () => {
      const entries = await listDirectory(tmpDir, true);

      const relativePaths = entries
        .map((e) => path.relative(tmpDir, e.path))
        .sort();

      expect(relativePaths).toContain("file1.txt");
      expect(relativePaths).toContain("file2.txt");
      expect(relativePaths).toContain("subdir");
      expect(relativePaths).toContain(path.join("subdir", "file3.txt"));
    });
  });

  describe("calculateContentHash", () => {
    it("should generate consistent hashes for string content", async () => {
      const content = "test content";

      const hash1 = await calculateContentHash(content);
      const hash2 = await calculateContentHash(content);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex string
    });

    it("should generate consistent hashes for binary content", async () => {
      const content = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

      const hash1 = await calculateContentHash(content);
      const hash2 = await calculateContentHash(content);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it("should generate different hashes for different content", async () => {
      const content1 = "content1";
      const content2 = "content2";

      const hash1 = await calculateContentHash(content1);
      const hash2 = await calculateContentHash(content2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("getMimeType", () => {
    it("should return correct MIME type for text files", () => {
      expect(getMimeType("test.txt")).toBe("text/plain");
      expect(getMimeType("test.json")).toBe("application/json");
      expect(getMimeType("test.html")).toBe("text/html");
    });

    it("should return default MIME type for unknown extensions", () => {
      expect(getMimeType("test.unknown")).toBe("application/octet-stream");
    });
  });

  describe("getFileExtension", () => {
    it("should extract file extensions", () => {
      expect(getFileExtension("test.txt")).toBe("txt");
      expect(getFileExtension("archive.tar.gz")).toBe("gz");
      expect(getFileExtension("noextension")).toBe("");
    });
  });

  describe("normalizePath", () => {
    it("should normalize path separators", () => {
      expect(normalizePath("path\\to\\file")).toBe("path/to/file");
      expect(normalizePath("path/to/file")).toBe("path/to/file");
      expect(normalizePath("path//to//file")).toBe("path/to/file");
    });
  });

  describe("getRelativePath", () => {
    it("should return relative paths", () => {
      const base = "/home/user/project";
      const target = "/home/user/project/src/file.txt";

      expect(getRelativePath(base, target)).toBe("src/file.txt");
    });

    it("should handle same directory", () => {
      const base = "/home/user/project";
      const target = "/home/user/project";

      expect(getRelativePath(base, target)).toBe(".");
    });
  });
});
