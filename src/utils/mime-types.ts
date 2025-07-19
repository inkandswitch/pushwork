import * as mimeTypes from "mime-types";

/**
 * Custom MIME type definitions for developer files
 * Based on patchwork-cli's approach
 */
const CUSTOM_MIME_TYPES: Record<string, string> = {
  // TypeScript files - override the incorrect video/mp2t detection
  ".ts": "text/typescript",
  ".tsx": "text/tsx",

  // Config file formats
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".conf": "text/plain",
  ".config": "text/plain",

  // Vue.js single file components
  ".vue": "text/vue",

  // Modern CSS preprocessors
  ".scss": "text/scss",
  ".sass": "text/sass",
  ".less": "text/less",
  ".styl": "text/stylus",

  // Modern JavaScript variants
  ".mjs": "application/javascript",
  ".cjs": "application/javascript",

  // React JSX
  ".jsx": "text/jsx",

  // Svelte components
  ".svelte": "text/svelte",

  // Web assembly
  ".wasm": "application/wasm",

  // Other common dev files
  ".d.ts": "text/typescript",
  ".map": "application/json", // Source maps
  ".env": "text/plain",
  ".gitignore": "text/plain",
  ".gitattributes": "text/plain",
  ".editorconfig": "text/plain",
  ".prettierrc": "application/json",
  ".eslintrc": "application/json",
  ".babelrc": "application/json",

  // Documentation formats
  ".mdx": "text/markdown",
  ".rst": "text/x-rst",

  // Docker files
  Dockerfile: "text/plain",
  ".dockerignore": "text/plain",

  // Package manager files
  "package.json": "application/json",
  "package-lock.json": "application/json",
  "yarn.lock": "text/plain",
  "pnpm-lock.yaml": "text/yaml",
  "composer.json": "application/json",
  Pipfile: "text/plain",
  "requirements.txt": "text/plain",

  // Build tool configs
  "webpack.config.js": "application/javascript",
  "vite.config.js": "application/javascript",
  "rollup.config.js": "application/javascript",
  "tsconfig.json": "application/json",
  "jsconfig.json": "application/json",
};

/**
 * File extensions that should always be treated as text
 * regardless of MIME type detection
 */
const FORCE_TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".env",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".d.ts",
  ".map",
  ".mdx",
  ".rst",
  ".toml",
  ".ini",
  ".conf",
  ".config",
  ".lock",
]);

/**
 * Get enhanced MIME type for file with custom dev file support
 */
export function getEnhancedMimeType(filePath: string): string {
  const filename = filePath.split("/").pop() || "";
  const extension = getFileExtension(filePath);

  // Check custom definitions first (by extension)
  if (extension && CUSTOM_MIME_TYPES[extension]) {
    return CUSTOM_MIME_TYPES[extension];
  }

  // Check custom definitions by full filename
  if (CUSTOM_MIME_TYPES[filename]) {
    return CUSTOM_MIME_TYPES[filename];
  }

  // Fall back to standard mime-types library
  const standardMime = mimeTypes.lookup(filePath);
  if (standardMime) {
    return standardMime;
  }

  // Final fallback
  return "application/octet-stream";
}

/**
 * Check if file extension should be forced to text type
 */
export function shouldForceAsText(filePath: string): boolean {
  const extension = getFileExtension(filePath);
  return extension ? FORCE_TEXT_EXTENSIONS.has(extension) : false;
}

/**
 * Get file extension including the dot (internal helper)
 */
function getFileExtension(filePath: string): string {
  const match = filePath.match(/\.[^.]*$/);
  return match ? match[0] : "";
}

/**
 * Enhanced text file detection with developer file support
 */
export async function isEnhancedTextFile(filePath: string): Promise<boolean> {
  // Force certain extensions to be treated as text
  if (shouldForceAsText(filePath)) {
    return true;
  }

  // Check MIME type
  const mimeType = getEnhancedMimeType(filePath);
  if (isTextMimeType(mimeType)) {
    return true;
  }

  // If it's a known binary type (but not the generic fallback), don't fall back to content detection
  if (isBinaryMimeType(mimeType) && mimeType !== "application/octet-stream") {
    return false;
  }

  // For generic octet-stream or unknown types, use content-based detection
  return isTextByContent(filePath);
}

/**
 * Check if MIME type indicates text content
 */
function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/javascript" ||
    mimeType === "application/typescript" ||
    mimeType === "application/toml" ||
    mimeType.includes("javascript") ||
    mimeType.includes("typescript") ||
    mimeType.includes("json") ||
    mimeType.includes("xml")
  );
}

/**
 * Check if MIME type indicates binary content
 */
function isBinaryMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("font/") ||
    mimeType === "application/zip" ||
    mimeType === "application/pdf" ||
    mimeType === "application/octet-stream" ||
    mimeType === "application/wasm" ||
    mimeType.includes("binary")
  );
}

/**
 * Content-based text detection (fallback method)
 */
async function isTextByContent(filePath: string): Promise<boolean> {
  try {
    const fs = await import("fs/promises");

    // Sample first 8KB to detect binary content
    const handle = await fs.open(filePath, "r");
    const stats = await handle.stat();
    const sampleSize = Math.min(8192, stats.size);

    if (sampleSize === 0) {
      await handle.close();
      return true; // Empty file is text
    }

    const buffer = Buffer.alloc(sampleSize);
    await handle.read(buffer, 0, sampleSize, 0);
    await handle.close();

    // Check for null bytes which indicate binary content
    return !buffer.includes(0);
  } catch {
    return false;
  }
}
