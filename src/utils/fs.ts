import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { glob } from "glob";
import * as mimeTypes from "mime-types";
import * as ignore from "ignore";
import * as A from "@automerge/automerge";
import { FileSystemEntry, FileType } from "../types";
import { isEnhancedTextFile } from "./mime-types";

/**
 * Check if a path exists
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file system entry metadata
 */
export async function getFileSystemEntry(
  filePath: string
): Promise<FileSystemEntry | null> {
  try {
    const stats = await fs.stat(filePath);
    const type = stats.isDirectory()
      ? FileType.DIRECTORY
      : (await isEnhancedTextFile(filePath))
      ? FileType.TEXT
      : FileType.BINARY;

    return {
      path: filePath,
      type,
      size: stats.size,
      mtime: stats.mtime,
      permissions: stats.mode & parseInt("777", 8),
    };
  } catch {
    return null;
  }
}

/**
 * Determine if a file is text or binary
 */
export async function isTextFile(filePath: string): Promise<boolean> {
  try {
    const mimeType = mimeTypes.lookup(filePath);
    if (mimeType) {
      return (
        mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "application/xml" ||
        mimeType.includes("javascript") ||
        mimeType.includes("typescript")
      );
    }

    // Sample first 8KB to detect binary content
    const handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(Math.min(8192, (await handle.stat()).size));
    await handle.read(buffer, 0, buffer.length, 0);
    await handle.close();

    // Check for null bytes which indicate binary content
    return !buffer.includes(0);
  } catch {
    return false;
  }
}

/**
 * Read file content as string or buffer
 */
export async function readFileContent(
  filePath: string
): Promise<string | Uint8Array> {
  const isText = await isEnhancedTextFile(filePath);

  if (isText) {
    return await fs.readFile(filePath, "utf8");
  } else {
    const buffer = await fs.readFile(filePath);
    return new Uint8Array(buffer);
  }
}

/**
 * Write file content from string or buffer
 */
export async function writeFileContent(
  filePath: string,
  content: string | A.ImmutableString | Uint8Array
): Promise<void> {
  await ensureDirectoryExists(path.dirname(filePath));

  if (typeof content === "string") {
    await fs.writeFile(filePath, content, "utf8");
  } else if (A.isImmutableString(content)) {
    // Convert ImmutableString to regular string for filesystem operations
    await fs.writeFile(filePath, content.toString(), "utf8");
  } else {
    await fs.writeFile(filePath, content);
  }
}

/**
 * Ensure directory exists, creating it if necessary
 */
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error: any) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * Remove file or directory
 */
export async function removePath(filePath: string): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      await fs.rm(filePath, { recursive: true });
    } else {
      await fs.unlink(filePath);
    }
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Check if a path matches any of the exclude patterns using the ignore library
 * Supports proper gitignore-style patterns (e.g., "node_modules", "*.tmp", ".git")
 */
function isExcluded(
  filePath: string,
  basePath: string,
  excludePatterns: string[]
): boolean {
  if (excludePatterns.length === 0) return false;

  const relativePath = path.relative(basePath, filePath);

  // Use the ignore library which implements proper .gitignore semantics
  // This is the same library used by ESLint and other major tools
  const ig = ignore.default().add(excludePatterns);

  return ig.ignores(relativePath);
}

/**
 * List directory contents with metadata
 */
export async function listDirectory(
  dirPath: string,
  recursive = false,
  excludePatterns: string[] = []
): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];

  try {
    // Construct pattern using path.join for proper cross-platform handling
    const pattern = recursive
      ? path.join(dirPath, "**/*")
      : path.join(dirPath, "*");
    
    // CRITICAL: glob expects forward slashes, even on Windows
    // Convert backslashes to forward slashes for glob pattern
    const normalizedPattern = pattern.replace(/\\/g, "/");

    // Use glob to get all paths (with dot files)
    // Note: We don't use glob's ignore option because it doesn't support gitignore semantics
    const paths = await glob(normalizedPattern, {
      dot: true,
    });

    // Parallelize all stat calls for better performance
    const allEntries = await Promise.all(
      paths.map(async (filePath) => {
        // Filter using proper gitignore semantics from the ignore library
        if (isExcluded(filePath, dirPath, excludePatterns)) {
          return null;
        }
        return await getFileSystemEntry(filePath);
      })
    );

    // Filter out null entries (excluded files or files that couldn't be read)
    entries.push(...allEntries.filter((e): e is FileSystemEntry => e !== null));
  } catch {
    // Return empty array if directory doesn't exist or can't be read
  }

  return entries;
}

/**
 * Copy file with metadata preservation
 */
export async function copyFile(
  sourcePath: string,
  destPath: string
): Promise<void> {
  await ensureDirectoryExists(path.dirname(destPath));
  await fs.copyFile(sourcePath, destPath);

  // Preserve file permissions
  const stats = await fs.stat(sourcePath);
  await fs.chmod(destPath, stats.mode);
}

/**
 * Move/rename file or directory
 */
export async function movePath(
  sourcePath: string,
  destPath: string
): Promise<void> {
  await ensureDirectoryExists(path.dirname(destPath));
  await fs.rename(sourcePath, destPath);
}

/**
 * Calculate content hash for change detection
 */
export async function calculateContentHash(
  content: string | A.ImmutableString | Uint8Array
): Promise<string> {
  const hash = crypto.createHash("sha256");
  if (A.isImmutableString(content)) {
    hash.update(content.toString());
  } else {
    hash.update(content);
  }
  return hash.digest("hex");
}

/**
 * Get MIME type for file
 */
export function getMimeType(filePath: string): string {
  return mimeTypes.lookup(filePath) || "application/octet-stream";
}

/**
 * Get file extension
 */
export function getFileExtension(filePath: string): string {
  const ext = path.extname(filePath);
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

/**
 * Normalize path separators for cross-platform compatibility
 * Converts all path separators to forward slashes for consistent storage
 */
export function normalizePath(filePath: string): string {
  return path.posix.normalize(filePath.replace(/\\/g, "/"));
}

/**
 * Join paths and normalize separators for cross-platform compatibility
 * Use this instead of string concatenation to ensure proper path handling on Windows
 */
export function joinAndNormalizePath(...paths: string[]): string {
  // Use path.join to properly handle path construction (handles Windows drive letters, etc.)
  const joined = path.join(...paths);
  // Then normalize to forward slashes for consistent storage/comparison
  return normalizePath(joined);
}

/**
 * Get relative path from base directory
 */
export function getRelativePath(basePath: string, filePath: string): string {
  return normalizePath(path.relative(basePath, filePath));
}

/**
 * Format a path as a relative path with proper prefix
 * Ensures paths like "src" become "./src" for clarity
 * Leaves absolute paths and paths already starting with . or .. unchanged
 */
export function formatRelativePath(filePath: string): string {
  // Already starts with . or / - leave as-is
  if (filePath.startsWith(".") || filePath.startsWith("/")) {
    return filePath;
  }
  // Add ./ prefix for clarity
  return `./${filePath}`;
}
