import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import { getMimeType, isTextFile } from "../../src/utils";

describe("MIME Type Detection", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), "mime-test-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("Current MIME Type Behavior", () => {
    it("should show current MIME detection for developer files", async () => {
      const testCases = [
        { filename: "script.ts", shouldBeText: true },
        { filename: "component.tsx", shouldBeText: true },
        { filename: "config.json", shouldBeText: true },
        { filename: "style.css", shouldBeText: true },
        { filename: "document.md", shouldBeText: true },
        { filename: "script.js", shouldBeText: true },
        { filename: "app.vue", shouldBeText: true },
        { filename: "style.scss", shouldBeText: true },
        { filename: "image.png", shouldBeText: false },
        { filename: "archive.zip", shouldBeText: false },
      ];

      console.log("Current MIME Detection Results:");
      console.log("================================");

      for (const testCase of testCases) {
        const filePath = path.join(testDir, testCase.filename);

        // Create test file with appropriate content
        const content = testCase.shouldBeText
          ? `// Test content for ${testCase.filename}\nconst x = 1;`
          : Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP header for binary files

        await fs.writeFile(filePath, content);

        // Test MIME type detection
        const detectedMime = getMimeType(filePath);
        const isText = await isTextFile(filePath);

        console.log(
          `${testCase.filename.padEnd(15)} | MIME: ${detectedMime.padEnd(
            30
          )} | Text: ${isText}`
        );

        // Test text/binary classification (should work correctly)
        expect(isText).toBe(testCase.shouldBeText);
      }
    });

    it("should detect TypeScript files as problematic with current MIME setup", async () => {
      const tsFile = path.join(testDir, "test.ts");
      await fs.writeFile(tsFile, "interface User { name: string; }");

      const mimeType = getMimeType(tsFile);
      const isText = await isTextFile(tsFile);

      // Current issue: .ts files are detected as video/mp2t (MPEG transport stream)
      expect(mimeType).toBe("video/mp2t"); // This is the problem!
      expect(isText).toBe(true); // But our content detection works
    });

    it("should detect TSX files as problematic with current MIME setup", async () => {
      const tsxFile = path.join(testDir, "component.tsx");
      await fs.writeFile(tsxFile, "export const App = () => <div>Hello</div>;");

      const mimeType = getMimeType(tsxFile);
      const isText = await isTextFile(tsxFile);

      // Current issue: .tsx files have no MIME type
      expect(mimeType).toBe("application/octet-stream"); // Generic fallback
      expect(isText).toBe(true); // But our content detection works
    });

    it("should handle files without extensions", async () => {
      const readmeFile = path.join(testDir, "README");
      await fs.writeFile(
        readmeFile,
        "# This is a README file\nSome documentation here."
      );

      const mimeType = getMimeType(readmeFile);
      const isText = await isTextFile(readmeFile);

      expect(mimeType).toBe("application/octet-stream"); // fallback for no extension
      expect(isText).toBe(true); // should detect as text by content
    });

    it("should properly detect binary files", async () => {
      const binaryFile = path.join(testDir, "binary.dat");
      const binaryContent = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]); // PNG-like header
      await fs.writeFile(binaryFile, binaryContent);

      const isText = await isTextFile(binaryFile);
      expect(isText).toBe(false);
    });

    it("should handle edge cases in text detection", async () => {
      // Empty file
      const emptyFile = path.join(testDir, "empty.txt");
      await fs.writeFile(emptyFile, "");
      expect(await isTextFile(emptyFile)).toBe(true);

      // Very small file
      const smallFile = path.join(testDir, "small.txt");
      await fs.writeFile(smallFile, "a");
      expect(await isTextFile(smallFile)).toBe(true);

      // File with UTF-8 content
      const utf8File = path.join(testDir, "utf8.txt");
      await fs.writeFile(utf8File, "Hello 世界 🌍");
      expect(await isTextFile(utf8File)).toBe(true);
    });
  });

  describe("MIME Type Issues We Should Fix", () => {
    it("should identify specific problems with developer file types", () => {
      // Document the specific MIME type issues we found
      const problems = [
        {
          extension: ".ts",
          currentMime: getMimeType("test.ts"),
          expectedMime: "text/typescript",
          problem: "Detected as video/mp2t (MPEG transport stream)",
        },
        {
          extension: ".tsx",
          currentMime: getMimeType("test.tsx"),
          expectedMime: "text/tsx",
          problem: "No MIME type, falls back to application/octet-stream",
        },
        {
          extension: ".vue",
          currentMime: getMimeType("test.vue"),
          expectedMime: "text/vue",
          problem: "Not recognized as text template",
        },
        {
          extension: ".scss",
          currentMime: getMimeType("test.scss"),
          expectedMime: "text/scss",
          problem: "Not recognized as stylesheet",
        },
      ];

      console.log("\nMIME Type Problems Found:");
      console.log("========================");

      problems.forEach((issue) => {
        console.log(
          `${issue.extension.padEnd(6)} | Current: ${issue.currentMime.padEnd(
            25
          )} | Problem: ${issue.problem}`
        );

        // Assert the problems exist (so we know when they're fixed)
        if (issue.extension === ".ts") {
          expect(issue.currentMime).toBe("video/mp2t");
        } else if (issue.extension === ".tsx") {
          expect(issue.currentMime).toBe("application/octet-stream");
        }
      });
    });
  });
});
