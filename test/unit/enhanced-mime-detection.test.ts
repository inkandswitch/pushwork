import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import {
  getEnhancedMimeType,
  isEnhancedTextFile,
  shouldForceAsText,
  getMimeType,
} from "../../src/utils";

describe("Enhanced MIME Detection", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), "enhanced-mime-test-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("Enhanced vs Standard MIME Detection", () => {
    it("should fix TypeScript file MIME detection", async () => {
      const tsFile = path.join(testDir, "test.ts");
      await fs.writeFile(tsFile, "interface User { name: string; }");

      // Standard MIME detection (broken)
      const standardMime = getMimeType(tsFile);

      // Enhanced MIME detection (fixed)
      const enhancedMime = getEnhancedMimeType(tsFile);
      const enhancedIsText = await isEnhancedTextFile(tsFile);
      const shouldForce = shouldForceAsText(tsFile);

      // Verify the fix
      expect(enhancedMime).toBe("text/typescript"); // Fixed!
      expect(enhancedIsText).toBe(true); // Fixed!
      expect(shouldForce).toBe(true); // Force TypeScript as text

      // Show the original problem still exists with standard detection
      expect(standardMime).toBe("video/mp2t"); // The original problem
    });

    it("should fix TSX file MIME detection", async () => {
      const tsxFile = path.join(testDir, "Component.tsx");
      await fs.writeFile(tsxFile, "export const App = () => <div>Hello</div>;");

      const standardMime = getMimeType(tsxFile);
      const enhancedMime = getEnhancedMimeType(tsxFile);
      const enhancedIsText = await isEnhancedTextFile(tsxFile);

      expect(enhancedMime).toBe("text/tsx"); // Fixed!
      expect(enhancedIsText).toBe(true); // Fixed!
      expect(standardMime).toBe("application/octet-stream"); // Original problem
    });

    it("should handle Vue.js single file components", async () => {
      const vueFile = path.join(testDir, "App.vue");
      await fs.writeFile(
        vueFile,
        `
<template>
  <div>{{ message }}</div>
</template>

<script>
export default {
  data() {
    return { message: 'Hello Vue!' }
  }
}
</script>

<style scoped>
div { color: blue; }
</style>
`
      );

      const enhancedMime = getEnhancedMimeType(vueFile);
      const enhancedIsText = await isEnhancedTextFile(vueFile);

      expect(enhancedMime).toBe("text/vue");
      expect(enhancedIsText).toBe(true);
    });

    it("should handle modern CSS preprocessors correctly", async () => {
      const testCases = [
        { file: "styles.scss", expectedMime: "text/scss" },
        { file: "styles.sass", expectedMime: "text/sass" },
        { file: "styles.less", expectedMime: "text/less" },
        { file: "styles.styl", expectedMime: "text/stylus" },
      ];

      for (const testCase of testCases) {
        const filePath = path.join(testDir, testCase.file);
        await fs.writeFile(
          filePath,
          "$primary-color: #007bff;\n.button { color: $primary-color; }"
        );

        const enhancedMime = getEnhancedMimeType(filePath);
        const enhancedIsText = await isEnhancedTextFile(filePath);

        expect(enhancedMime).toBe(testCase.expectedMime);
        expect(enhancedIsText).toBe(true);
      }
    });

    it("should handle configuration files by filename", async () => {
      const configFiles = [
        { filename: "Dockerfile", expectedMime: "text/plain" },
        { filename: "package.json", expectedMime: "application/json" },
        { filename: "tsconfig.json", expectedMime: "application/json" },
        {
          filename: "webpack.config.js",
          expectedMime: "application/javascript",
        },
      ];

      for (const config of configFiles) {
        const filePath = path.join(testDir, config.filename);
        await fs.writeFile(filePath, "# Configuration content");

        const enhancedMime = getEnhancedMimeType(filePath);
        const enhancedIsText = await isEnhancedTextFile(filePath);

        expect(enhancedMime).toBe(config.expectedMime);
        expect(enhancedIsText).toBe(true);
      }
    });
  });

  describe("Comprehensive Developer File Support", () => {
    it("should correctly handle all common developer file types", async () => {
      const developerFiles = [
        // JavaScript/TypeScript ecosystem
        { name: "app.js", mime: "application/javascript", text: true },
        { name: "app.ts", mime: "text/typescript", text: true },
        { name: "Component.tsx", mime: "text/tsx", text: true },
        { name: "Component.jsx", mime: "text/jsx", text: true },
        { name: "types.d.ts", mime: "text/typescript", text: true },
        { name: "bundle.mjs", mime: "application/javascript", text: true },
        { name: "server.cjs", mime: "application/javascript", text: true },

        // Frontend frameworks
        { name: "App.vue", mime: "text/vue", text: true },
        { name: "Button.svelte", mime: "text/svelte", text: true },

        // Stylesheets
        { name: "styles.scss", mime: "text/scss", text: true },
        { name: "main.css", mime: "text/css", text: true },

        // Documentation
        { name: "README.md", mime: "text/markdown", text: true },
        { name: "docs.mdx", mime: "text/markdown", text: true },

        // Config files
        { name: ".env", mime: "text/plain", text: true },
        { name: ".gitignore", mime: "text/plain", text: true },
        { name: "config.toml", mime: "application/toml", text: true },

        // Source maps and build artifacts
        { name: "app.js.map", mime: "application/json", text: true },

        // Binary files (should not be forced as text)
        { name: "image.png", mime: "image/png", text: false },
        { name: "font.woff2", mime: "font/woff2", text: false },
      ];

      for (const file of developerFiles) {
        const filePath = path.join(testDir, file.name);

        // Create appropriate content
        const content = file.text
          ? `// Content for ${file.name}\nconst test = true;`
          : Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG-like header

        await fs.writeFile(filePath, content);

        const enhancedMime = getEnhancedMimeType(filePath);
        const enhancedIsText = await isEnhancedTextFile(filePath);

        expect(enhancedMime).toBe(file.mime);
        expect(enhancedIsText).toBe(file.text);
      }
    });
  });

  describe("Edge Cases and Fallbacks", () => {
    it("should handle files without extensions", async () => {
      const noExtFile = path.join(testDir, "README");
      await fs.writeFile(noExtFile, "# This is a README file");

      const enhancedMime = getEnhancedMimeType(noExtFile);
      const enhancedIsText = await isEnhancedTextFile(noExtFile);

      // Should fall back to content-based detection
      expect(enhancedMime).toBe("application/octet-stream");
      expect(enhancedIsText).toBe(true); // Detected as text by content
    });

    it("should prioritize custom definitions over standard library", async () => {
      // .ts files are wrongly detected as video/mp2t by standard library
      const tsFile = path.join(testDir, "test.ts");
      await fs.writeFile(tsFile, "const x: string = 'test';");

      const standardMime = getMimeType(tsFile);
      const enhancedMime = getEnhancedMimeType(tsFile);

      expect(standardMime).toBe("video/mp2t"); // Wrong
      expect(enhancedMime).toBe("text/typescript"); // Corrected by our custom definitions
    });

    it("should handle empty files correctly", async () => {
      const emptyFile = path.join(testDir, "empty.ts");
      await fs.writeFile(emptyFile, "");

      const enhancedMime = getEnhancedMimeType(emptyFile);
      const enhancedIsText = await isEnhancedTextFile(emptyFile);

      expect(enhancedMime).toBe("text/typescript");
      expect(enhancedIsText).toBe(true); // Empty files should be treated as text
    });

    it("should ensure TypeScript files are read as strings (integration test)", async () => {
      const tsFile = path.join(testDir, "integration.ts");
      const tsContent = "interface Config { apiUrl: string; timeout: number; }";
      await fs.writeFile(tsFile, tsContent);

      // Import readFileContent here to test integration
      const { readFileContent } = await import("../../src/utils");

      const result = await readFileContent(tsFile);

      // Critical: TypeScript files MUST be read as strings
      expect(typeof result).toBe("string");
      expect(result).toBe(tsContent);

      // This test would have FAILED before our fix when readFileContent
      // used isTextFile() instead of isEnhancedTextFile()
    });
  });
});
