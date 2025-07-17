import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { glob } from "glob";
import * as mimeTypes from "mime-types";
import { FileSystemEntry, FileType } from "../types";

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
      : (await isTextFile(filePath))
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
  const isText = await isTextFile(filePath);

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
  content: string | Uint8Array
): Promise<void> {
  await ensureDirectoryExists(path.dirname(filePath));

  if (typeof content === "string") {
    await fs.writeFile(filePath, content, "utf8");
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
      await fs.rmdir(filePath, { recursive: true });
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
 * List directory contents with metadata
 */
export async function listDirectory(
  dirPath: string,
  recursive = false
): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];

  try {
    const pattern = recursive
      ? path.join(dirPath, "**/*")
      : path.join(dirPath, "*");
    const paths = await glob(pattern, { dot: true });

    for (const filePath of paths) {
      const entry = await getFileSystemEntry(filePath);
      if (entry) {
        entries.push(entry);
      }
    }
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
  content: string | Uint8Array
): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(content);
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
 */
export function normalizePath(filePath: string): string {
  return path.posix.normalize(filePath.replace(/\\/g, "/"));
}

/**
 * Get relative path from base directory
 */
export function getRelativePath(basePath: string, filePath: string): string {
  return normalizePath(path.relative(basePath, filePath));
}
