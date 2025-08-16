/**
 * Browser-specific filesystem utilities using File System Access API
 */

import { FileSystemEntry, FileType } from "../types";
import {
  normalizePath,
  getRelativePath,
  matchesExcludePatterns,
  calculateContentHash,
} from "./pure";
import { getEnhancedMimeType, isEnhancedTextFile } from "./mime-types";

// Global reference to root directory handle (set by sync engine)
let rootDirectoryHandle: any = null;

/**
 * Set the root directory handle for browser filesystem operations
 */
export function setRootDirectoryHandle(handle: any): void {
  rootDirectoryHandle = handle;
}

/**
 * Get the root directory handle
 */
export function getRootDirectoryHandle(): any {
  if (!rootDirectoryHandle) {
    throw new Error(
      "Root directory handle not set. Call setRootDirectoryHandle() first."
    );
  }
  return rootDirectoryHandle;
}

/**
 * Get file or directory handle by path
 */
async function getHandleByPath(path: string): Promise<any> {
  const root = getRootDirectoryHandle();
  const normalizedPath = normalizePath(path);

  if (normalizedPath === "." || normalizedPath === "") {
    return root;
  }

  const parts = normalizedPath.split("/").filter((p) => p);
  let currentHandle = root;

  for (const part of parts) {
    try {
      // Try as directory first
      currentHandle = await currentHandle.getDirectoryHandle(part);
    } catch {
      try {
        // Try as file
        currentHandle = await currentHandle.getFileHandle(part);
      } catch {
        throw new Error(`Path not found: ${path}`);
      }
    }
  }

  return currentHandle;
}

/**
 * Check if a path exists
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await getHandleByPath(filePath);
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
    const handle = await getHandleByPath(filePath);

    if (handle.kind === "file") {
      const file = await handle.getFile();
      return {
        path: filePath,
        type: (await isTextFile(filePath)) ? FileType.TEXT : FileType.BINARY,
        size: file.size,
        mtime: new Date(file.lastModified),
        permissions: 0o644, // Default permissions for browser
      };
    } else {
      return {
        path: filePath,
        type: FileType.DIRECTORY,
        size: 0,
        mtime: new Date(), // Directories don't have meaningful timestamps in browser
        permissions: 0o755,
      };
    }
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
  try {
    return await isEnhancedTextFile(filePath);
  } catch {
    return false;
  }
}

/**
 * Read file content
 */
export async function readFileContent(
  filePath: string
): Promise<string | Uint8Array> {
  try {
    const handle = await getHandleByPath(filePath);
    if (handle.kind !== "file") {
      throw new Error(`${filePath} is not a file`);
    }

    const file = await handle.getFile();

    if (await isTextFile(filePath)) {
      return await file.text();
    } else {
      return new Uint8Array(await file.arrayBuffer());
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
    const root = getRootDirectoryHandle();
    const normalizedPath = normalizePath(filePath);
    const parts = normalizedPath.split("/").filter((p) => p);

    // Ensure parent directories exist
    let currentHandle = root;
    for (const part of parts.slice(0, -1)) {
      try {
        currentHandle = await currentHandle.getDirectoryHandle(part);
      } catch {
        currentHandle = await currentHandle.getDirectoryHandle(part, {
          create: true,
        });
      }
    }

    // Create or get file
    const fileName = parts[parts.length - 1];
    const fileHandle = await currentHandle.getFileHandle(fileName, {
      create: true,
    });

    // Write content
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  } catch (error) {
    throw new Error(`Failed to write file ${filePath}: ${error}`);
  }
}

/**
 * Ensure directory exists
 */
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    const root = getRootDirectoryHandle();
    const normalizedPath = normalizePath(dirPath);

    if (normalizedPath === "." || normalizedPath === "") {
      return; // Root already exists
    }

    const parts = normalizedPath.split("/").filter((p) => p);
    let currentHandle = root;

    for (const part of parts) {
      try {
        currentHandle = await currentHandle.getDirectoryHandle(part);
      } catch {
        currentHandle = await currentHandle.getDirectoryHandle(part, {
          create: true,
        });
      }
    }
  } catch (error) {
    throw new Error(`Failed to create directory ${dirPath}: ${error}`);
  }
}

/**
 * Remove a file or directory
 */
export async function removePath(filePath: string): Promise<void> {
  try {
    const root = getRootDirectoryHandle();
    const normalizedPath = normalizePath(filePath);
    const parts = normalizedPath.split("/").filter((p) => p);

    if (parts.length === 0) {
      throw new Error("Cannot remove root directory");
    }

    // Navigate to parent directory
    let parentHandle = root;
    for (const part of parts.slice(0, -1)) {
      parentHandle = await parentHandle.getDirectoryHandle(part);
    }

    const name = parts[parts.length - 1];

    // Try to remove as file first, then as directory
    try {
      await parentHandle.removeEntry(name);
    } catch {
      await parentHandle.removeEntry(name, { recursive: true });
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
    const handle = await getHandleByPath(dirPath);
    if (handle.kind !== "directory") {
      throw new Error(`${dirPath} is not a directory`);
    }

    const results: FileSystemEntry[] = [];

    for await (const [name, entryHandle] of handle.entries()) {
      // Skip excluded patterns
      if (matchesExcludePatterns(name, excludePatterns)) {
        continue;
      }

      const fullPath = normalizePath(`${dirPath}/${name}`);

      if (entryHandle.kind === "file") {
        const file = await entryHandle.getFile();
        results.push({
          path: fullPath,
          type: (await isTextFile(fullPath)) ? FileType.TEXT : FileType.BINARY,
          size: file.size,
          mtime: new Date(file.lastModified),
          permissions: 0o644,
        });
      } else {
        results.push({
          path: fullPath,
          type: FileType.DIRECTORY,
          size: 0,
          mtime: new Date(),
          permissions: 0o755,
        });
      }
    }

    return results;
  } catch (error) {
    throw new Error(`Failed to list directory ${dirPath}: ${error}`);
  }
}

/**
 * Copy a file (not supported in File System Access API)
 */
export async function copyFile(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  try {
    const content = await readFileContent(sourcePath);
    await writeFileContent(targetPath, content);
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
    // In File System Access API, we need to copy then delete
    const sourceHandle = await getHandleByPath(sourcePath);

    if (sourceHandle.kind === "file") {
      const content = await readFileContent(sourcePath);
      await writeFileContent(targetPath, content);
      await removePath(sourcePath);
    } else {
      throw new Error("Moving directories not yet implemented in browser");
    }
  } catch (error) {
    throw new Error(`Failed to move ${sourcePath} to ${targetPath}: ${error}`);
  }
}

/**
 * Get MIME type
 */
export function getMimeType(filePath: string): string {
  return getEnhancedMimeType(filePath);
}
