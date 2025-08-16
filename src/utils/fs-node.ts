/**
 * Node.js-specific filesystem utilities
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { glob } from "glob";
import * as mimeTypes from "mime-types";
import { FileSystemEntry, FileType } from "../types";
import { normalizePath, getRelativePath, matchesExcludePatterns } from "./pure";
import { isTextFile as isTextFileOriginal } from "./fs";

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
 * Get file system entry information
 */
export async function getFileSystemEntry(
  filePath: string
): Promise<FileSystemEntry> {
  try {
    const stats = await fs.stat(filePath);
    return {
      path: filePath,
      type: stats.isDirectory()
        ? FileType.DIRECTORY
        : stats.isFile()
        ? FileType.TEXT
        : FileType.BINARY,
      size: stats.size,
      mtime: stats.mtime,
      permissions: stats.mode & parseInt("777", 8),
    };
  } catch (error) {
    throw new Error(
      `Failed to get file system entry for ${filePath}: ${error}`
    );
  }
}

/**
 * Check if a file is a text file
 */
export async function isTextFile(filePath: string): Promise<boolean> {
  return isTextFileOriginal(filePath);
}

/**
 * Read file content
 */
export async function readFileContent(
  filePath: string
): Promise<string | Uint8Array> {
  try {
    if (await isTextFile(filePath)) {
      return await fs.readFile(filePath, "utf8");
    } else {
      return new Uint8Array(await fs.readFile(filePath));
    }
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${error}`);
  }
}

/**
 * Write file content
 */
export async function writeFileContent(
  filePath: string,
  content: string | Uint8Array
): Promise<void> {
  try {
    await fs.writeFile(filePath, content);
  } catch (error) {
    throw new Error(`Failed to write file ${filePath}: ${error}`);
  }
}

/**
 * Ensure directory exists
 */
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if ((error as any).code !== "EEXIST") {
      throw new Error(`Failed to create directory ${dirPath}: ${error}`);
    }
  }
}

/**
 * Remove a file or directory
 */
export async function removePath(filePath: string): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      await fs.rmdir(filePath, { recursive: true });
    } else {
      await fs.unlink(filePath);
    }
  } catch (error) {
    throw new Error(`Failed to remove ${filePath}: ${error}`);
  }
}

/**
 * List directory contents
 */
export async function listDirectory(
  dirPath: string,
  excludePatterns: string[] = []
): Promise<FileSystemEntry[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const results: FileSystemEntry[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = getRelativePath(dirPath, fullPath);

      // Skip excluded patterns
      if (matchesExcludePatterns(entry.name, excludePatterns)) {
        continue;
      }

      const stats = await fs.stat(fullPath);
      results.push({
        path: fullPath,
        type: entry.isDirectory() ? FileType.DIRECTORY : FileType.TEXT,
        size: stats.size,
        mtime: stats.mtime,
        permissions: stats.mode & parseInt("777", 8),
      });
    }

    return results;
  } catch (error) {
    throw new Error(`Failed to list directory ${dirPath}: ${error}`);
  }
}

/**
 * Copy a file
 */
export async function copyFile(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  try {
    await fs.copyFile(sourcePath, targetPath);
  } catch (error) {
    throw new Error(`Failed to copy ${sourcePath} to ${targetPath}: ${error}`);
  }
}

/**
 * Move a file or directory
 */
export async function movePath(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    throw new Error(`Failed to move ${sourcePath} to ${targetPath}: ${error}`);
  }
}

/**
 * Calculate content hash using crypto
 */
export function calculateContentHashNode(content: string | Uint8Array): string {
  const hash = crypto.createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

/**
 * Get MIME type
 */
export function getMimeType(filePath: string): string {
  return mimeTypes.lookup(filePath) || "application/octet-stream";
}
