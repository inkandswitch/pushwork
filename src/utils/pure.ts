/**
 * Pure utility functions that work in both Node.js and browser environments
 * These functions don't depend on any platform-specific APIs
 */

/**
 * Get file extension from a file path
 */
export function getFileExtension(filePath: string): string {
  const parts = filePath.split(".");
  if (parts.length < 2) return "";
  const ext = parts[parts.length - 1];
  return ext.startsWith(".") ? ext : `.${ext}`;
}

/**
 * Normalize file path to use forward slashes and resolve relative components
 */
export function normalizePath(filePath: string): string {
  // Convert backslashes to forward slashes
  let normalized = filePath.replace(/\\/g, "/");

  // Split into parts and process
  const parts = normalized.split("/");
  const result: string[] = [];

  for (const part of parts) {
    if (part === "" && result.length === 0) {
      // Leading slash - keep it
      result.push("");
    } else if (part === "" || part === ".") {
      // Empty or current directory - skip
      continue;
    } else if (part === "..") {
      // Parent directory
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      } else if (result.length === 0 || result[0] !== "") {
        // Not an absolute path, can go up
        result.push("..");
      }
    } else {
      result.push(part);
    }
  }

  const final = result.join("/");
  return final || (filePath.startsWith("/") ? "/" : ".");
}

/**
 * Get relative path from base to target
 */
export function getRelativePath(basePath: string, targetPath: string): string {
  const base = normalizePath(basePath)
    .split("/")
    .filter((p) => p !== "");
  const target = normalizePath(targetPath)
    .split("/")
    .filter((p) => p !== "");

  // Find common prefix length
  let commonLength = 0;
  for (let i = 0; i < Math.min(base.length, target.length); i++) {
    if (base[i] === target[i]) {
      commonLength++;
    } else {
      break;
    }
  }

  // Build relative path
  const upLevels = base.length - commonLength;
  const downPath = target.slice(commonLength);

  const parts = [];
  for (let i = 0; i < upLevels; i++) {
    parts.push("..");
  }
  parts.push(...downPath);

  return parts.length === 0 ? "." : parts.join("/");
}

/**
 * Simple content hash calculation (browser-compatible)
 */
export function calculateContentHash(content: string | Uint8Array): string {
  let hash = 0;
  const str =
    typeof content === "string" ? content : new TextDecoder().decode(content);

  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  return Math.abs(hash).toString(16);
}

/**
 * Check if a path matches any of the exclude patterns
 */
export function matchesExcludePatterns(
  path: string,
  patterns: string[]
): boolean {
  return patterns.some((pattern) => {
    // Simple glob pattern matching
    const regex = new RegExp(
      "^" +
        pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") +
        "$"
    );
    return regex.test(path);
  });
}
