/**
 * Browser filesystem adapter using File System Access API with browser-fs-access fallbacks
 */

import { FileSystemEntry, FileType } from "../types";
import {
  BrowserDirectoryHandle,
  BrowserFileHandle,
  BrowserFileSystemEntry,
  DirectoryPickerOptions,
  BrowserSyncState,
} from "./types";
import { getEnhancedMimeType, isEnhancedTextFile } from "../utils/mime-types";
import { normalizePath } from "../utils";
import "./globals";

/**
 * Browser filesystem adapter that provides Node.js fs-like interface
 * using File System Access API with graceful fallbacks
 */
export class BrowserFilesystemAdapter {
  private state: BrowserSyncState = {
    rootHandle: null,
    hasPermission: false,
    isSupported: this.checkSupport(),
  };

  /**
   * Check if File System Access API is supported
   */
  private checkSupport(): boolean {
    return (
      typeof window !== "undefined" &&
      "showDirectoryPicker" in window &&
      "showFilePicker" in window
    );
  }

  /**
   * Check if File System Access API is supported
   */
  isSupported(): boolean {
    return this.state.isSupported;
  }

  /**
   * Get current sync state
   */
  getSyncState(): BrowserSyncState {
    return { ...this.state };
  }

  /**
   * Show directory picker and set as root directory
   */
  async showDirectoryPicker(
    options: DirectoryPickerOptions = {}
  ): Promise<BrowserDirectoryHandle> {
    try {
      // Use native File System Access API if available
      if (this.state.isSupported && "showDirectoryPicker" in window) {
        const handle = await window.showDirectoryPicker({
          mode: options.mode || "readwrite",
          startIn: options.startIn || "documents",
          id: options.id || "pushwork-sync",
        });

        this.state.rootHandle = handle;
        this.state.hasPermission = true;
        return handle;
      } else {
        // Fallback using dynamic import of browser-fs-access
        try {
          const { directoryOpen } = await import("browser-fs-access");
          const files = await directoryOpen({
            recursive: true,
            mode: options.mode || "readwrite",
          });

          // Create a virtual directory handle from the files
          const virtualHandle = this.createVirtualDirectoryHandle(files);
          this.state.rootHandle = virtualHandle;
          this.state.hasPermission = true;
          return virtualHandle;
        } catch (error) {
          throw new Error(`Browser-fs-access fallback failed: ${error}`);
        }
      }
    } catch (error) {
      console.error("Failed to show directory picker:", error);
      throw new Error(`Directory picker failed: ${error}`);
    }
  }

  /**
   * Read file content as string or Uint8Array
   */
  async readFileContent(
    handle: BrowserFileHandle
  ): Promise<string | Uint8Array> {
    try {
      const file = await handle.getFile();
      const isText = await this.isTextFile(file.name, file);

      if (isText) {
        return await file.text();
      } else {
        const arrayBuffer = await file.arrayBuffer();
        return new Uint8Array(arrayBuffer);
      }
    } catch (error) {
      throw new Error(`Failed to read file ${handle.name}: ${error}`);
    }
  }

  /**
   * Write file content from string or Uint8Array
   */
  async writeFileContent(
    handle: BrowserFileHandle,
    content: string | Uint8Array
  ): Promise<void> {
    try {
      // Check write permission
      const permission = await handle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        throw new Error(`Write permission denied for ${handle.name}`);
      }

      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
    } catch (error) {
      throw new Error(`Failed to write file ${handle.name}: ${error}`);
    }
  }

  /**
   * List directory contents with metadata
   */
  async listDirectory(
    dirHandle: BrowserDirectoryHandle,
    recursive = false,
    excludePatterns: string[] = []
  ): Promise<FileSystemEntry[]> {
    const entries: FileSystemEntry[] = [];

    try {
      await this.listDirectoryRecursive(
        dirHandle,
        "",
        entries,
        recursive,
        excludePatterns
      );
    } catch (error) {
      console.error("Failed to list directory:", error);
    }

    return entries;
  }

  /**
   * Create a file in the given directory
   */
  async createFile(
    dirHandle: BrowserDirectoryHandle,
    fileName: string,
    content: string | Uint8Array
  ): Promise<BrowserFileHandle> {
    const fileHandle = await dirHandle.getFileHandle(fileName, {
      create: true,
    });
    await this.writeFileContent(fileHandle, content);
    return fileHandle;
  }

  /**
   * Create a directory
   */
  async createDirectory(
    dirHandle: BrowserDirectoryHandle,
    dirName: string
  ): Promise<BrowserDirectoryHandle> {
    return await dirHandle.getDirectoryHandle(dirName, { create: true });
  }

  /**
   * Remove a file or directory
   */
  async removeEntry(
    dirHandle: BrowserDirectoryHandle,
    name: string,
    recursive = false
  ): Promise<void> {
    await dirHandle.removeEntry(name, { recursive });
  }

  /**
   * Get file handle by path relative to root
   */
  async getFileHandle(relativePath: string): Promise<BrowserFileHandle | null> {
    if (!this.state.rootHandle) {
      throw new Error("No root directory selected");
    }

    try {
      const pathParts = relativePath
        .split("/")
        .filter((part) => part.length > 0);
      let currentHandle: BrowserDirectoryHandle | BrowserFileHandle =
        this.state.rootHandle;

      // Navigate to parent directory
      for (let i = 0; i < pathParts.length - 1; i++) {
        if (currentHandle.kind !== "directory") {
          return null;
        }
        currentHandle = await currentHandle.getDirectoryHandle(pathParts[i]);
      }

      // Get the file
      if (currentHandle.kind === "directory") {
        const fileName = pathParts[pathParts.length - 1];
        return await currentHandle.getFileHandle(fileName);
      }

      return null;
    } catch (error) {
      console.warn(`Failed to get file handle for ${relativePath}:`, error);
      return null;
    }
  }

  /**
   * Get directory handle by path relative to root
   */
  async getDirectoryHandle(
    relativePath: string
  ): Promise<BrowserDirectoryHandle | null> {
    if (!this.state.rootHandle) {
      throw new Error("No root directory selected");
    }

    if (relativePath === "" || relativePath === ".") {
      return this.state.rootHandle;
    }

    try {
      const pathParts = relativePath
        .split("/")
        .filter((part) => part.length > 0);
      let currentHandle: BrowserDirectoryHandle = this.state.rootHandle;

      for (const part of pathParts) {
        currentHandle = await currentHandle.getDirectoryHandle(part);
      }

      return currentHandle;
    } catch (error) {
      console.warn(
        `Failed to get directory handle for ${relativePath}:`,
        error
      );
      return null;
    }
  }

  /**
   * Check if file is text or binary
   */
  private async isTextFile(fileName: string, file?: File): Promise<boolean> {
    // Use existing enhanced text file detection
    const isTextByExtension = await isEnhancedTextFile(fileName);
    if (isTextByExtension) return true;

    // If we have the file, sample content for binary detection
    if (file && file.size > 0) {
      try {
        const sampleSize = Math.min(8192, file.size);
        const buffer = await file.slice(0, sampleSize).arrayBuffer();
        const uint8Array = new Uint8Array(buffer);

        // Check for null bytes which indicate binary content
        return !uint8Array.includes(0);
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Recursive directory listing helper
   */
  private async listDirectoryRecursive(
    dirHandle: BrowserDirectoryHandle,
    currentPath: string,
    entries: FileSystemEntry[],
    recursive: boolean,
    excludePatterns: string[]
  ): Promise<void> {
    for await (const [name, handle] of dirHandle.entries()) {
      const fullPath = currentPath ? `${currentPath}/${name}` : name;

      // Check exclude patterns
      if (this.isExcluded(fullPath, excludePatterns)) {
        continue;
      }

      if (handle.kind === "file") {
        const file = await handle.getFile();
        const fileType = (await this.isTextFile(name, file))
          ? FileType.TEXT
          : FileType.BINARY;

        entries.push({
          path: normalizePath(fullPath),
          type: fileType,
          size: file.size,
          mtime: new Date(file.lastModified),
          permissions: 0o644, // Default permissions for browser files
        });
      } else if (handle.kind === "directory") {
        entries.push({
          path: normalizePath(fullPath),
          type: FileType.DIRECTORY,
          size: 0,
          mtime: new Date(),
          permissions: 0o755, // Default permissions for browser directories
        });

        if (recursive) {
          await this.listDirectoryRecursive(
            handle,
            fullPath,
            entries,
            recursive,
            excludePatterns
          );
        }
      }
    }
  }

  /**
   * Check if path should be excluded
   */
  private isExcluded(path: string, excludePatterns: string[]): boolean {
    for (const pattern of excludePatterns) {
      if (pattern.startsWith(".") && !pattern.includes("*")) {
        // Directory pattern like ".pushwork" or ".git"
        if (
          path.startsWith(pattern) ||
          path.includes(`/${pattern}/`) ||
          path.includes(`/${pattern}`)
        ) {
          return true;
        }
      } else if (pattern.includes("*")) {
        // Glob pattern like "*.tmp"
        const regex = new RegExp(
          pattern.replace(/\*/g, ".*").replace(/\?/g, ".")
        );
        if (regex.test(path)) {
          return true;
        }
      } else {
        // Exact directory name like "node_modules"
        const parts = path.split("/");
        if (parts.includes(pattern)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Create a virtual directory handle from browser-fs-access files
   * (for browsers that don't support File System Access API)
   */
  private createVirtualDirectoryHandle(files: File[]): BrowserDirectoryHandle {
    // This is a simplified implementation for fallback scenarios
    // In practice, you might want to use a more sophisticated virtual filesystem
    const self = this;

    const virtualHandle: BrowserDirectoryHandle = {
      kind: "directory" as const,
      name: "root",

      async *keys() {
        const names = new Set(files.map((file) => file.name.split("/")[0]));
        for (const name of names) {
          yield name;
        }
      },

      async *values() {
        // Simplified - return file handles for files in root
        for (const file of files) {
          if (!file.name.includes("/")) {
            yield self.createVirtualFileHandle(file);
          }
        }
      },

      async *entries() {
        for await (const key of this.keys()) {
          const file = files.find((f) => f.name === key);
          if (file) {
            yield [key, self.createVirtualFileHandle(file)] as [
              string,
              BrowserFileHandle
            ];
          }
        }
      },

      async getFileHandle(name: string): Promise<BrowserFileHandle> {
        const file = files.find((f) => f.name === name);
        if (!file) throw new Error(`File not found: ${name}`);
        return self.createVirtualFileHandle(file);
      },

      async getDirectoryHandle(): Promise<BrowserDirectoryHandle> {
        throw new Error("Virtual directory handles not fully implemented");
      },

      async removeEntry(): Promise<void> {
        throw new Error("Remove not supported in fallback mode");
      },

      async queryPermission(): Promise<"granted" | "denied" | "prompt"> {
        return "granted";
      },

      async requestPermission(): Promise<"granted" | "denied" | "prompt"> {
        return "granted";
      },
    };

    return virtualHandle;
  }

  /**
   * Create a virtual file handle from a File object
   */
  private createVirtualFileHandle(file: File): BrowserFileHandle {
    return {
      kind: "file" as const,
      name: file.name,

      async getFile(): Promise<File> {
        return file;
      },

      async createWritable(): Promise<any> {
        throw new Error("Writing not supported in fallback mode");
      },

      async queryPermission(): Promise<"granted" | "denied" | "prompt"> {
        return "granted";
      },

      async requestPermission(): Promise<"granted" | "denied" | "prompt"> {
        return "granted";
      },
    };
  }
}

// Export singleton instance
export const browserFS = new BrowserFilesystemAdapter();
