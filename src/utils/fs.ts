import * as fs from "fs/promises"
import * as path from "path"
import {glob} from "glob"
import * as mimeTypes from "mime-types"
import * as ignore from "ignore"
import {FileSystemEntry, FileType} from "../types"
import {isEnhancedTextFile, isLikelyUtf8Text} from "./mime-types"
import {mapWithConcurrency, IO_CONCURRENCY} from "./concurrency"

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}

export async function getFileSystemEntry(
	filePath: string
): Promise<FileSystemEntry | null> {
	try {
		const stats = await fs.stat(filePath)
		const type = stats.isDirectory()
			? FileType.DIRECTORY
			: (await isEnhancedTextFile(filePath))
				? FileType.TEXT
				: FileType.BINARY

		return {
			path: filePath,
			type,
			size: stats.size,
			mtime: stats.mtime,
			permissions: stats.mode & parseInt("777", 8),
		}
	} catch {
		return null
	}
}

/**
 * Determine if a file is text or binary
 */
export async function isTextFile(filePath: string): Promise<boolean> {
	try {
		const mimeType = mimeTypes.lookup(filePath)
		if (mimeType) {
			return (
				mimeType.startsWith("text/") ||
				mimeType === "application/json" ||
				mimeType === "application/xml" ||
				mimeType.includes("javascript") ||
				mimeType.includes("typescript")
			)
		}

		// Sample first 8KB to detect binary content
		const handle = await fs.open(filePath, "r")
		const buffer = Buffer.alloc(Math.min(8192, (await handle.stat()).size))
		await handle.read(buffer, 0, buffer.length, 0)
		await handle.close()

		// Treat as text only if the sample is valid UTF-8 (not merely
		// null-byte-free) — see isLikelyUtf8Text.
		return isLikelyUtf8Text(buffer)
	} catch {
		return false
	}
}

export async function readFileContent(
	filePath: string
): Promise<string | Uint8Array> {
	const buffer = await fs.readFile(filePath)

	// Return text only when the file is classified as text AND its bytes
	// survive a UTF-8 round-trip without loss. This is the safety net that
	// makes binary corruption unrepresentable: even if classification is
	// wrong, content that would be mangled by a UTF-8 decode is kept as bytes.
	if (await isEnhancedTextFile(filePath)) {
		const text = buffer.toString("utf8")
		if (Buffer.from(text, "utf8").equals(buffer)) {
			return text
		}
	}

	return new Uint8Array(buffer)
}

export async function writeFileContent(
	filePath: string,
	content: string | Uint8Array
): Promise<void> {
	await ensureDirectoryExists(path.dirname(filePath))

	if (typeof content === "string") {
		await fs.writeFile(filePath, content, "utf8")
	} else {
		await fs.writeFile(filePath, content)
	}
}

export async function ensureDirectoryExists(dirPath: string): Promise<void> {
	try {
		await fs.mkdir(dirPath, {recursive: true})
	} catch (error: any) {
		if (error.code !== "EEXIST") {
			throw error
		}
	}
}

export async function removePath(filePath: string): Promise<void> {
	try {
		const stats = await fs.stat(filePath)
		if (stats.isDirectory()) {
			await fs.rm(filePath, {recursive: true})
		} else {
			await fs.unlink(filePath)
		}
	} catch (error: any) {
		if (error.code !== "ENOENT") {
			throw error
		}
	}
}

/**
 * Build a reusable exclude predicate from gitignore-style patterns. The
 * `ignore` matcher is compiled once and closed over, rather than rebuilt
 * per path.
 */
function buildExcludeFilter(
	basePath: string,
	excludePatterns: string[]
): (filePath: string) => boolean {
	if (excludePatterns.length === 0) return () => false

	// Same library used by ESLint et al. for proper .gitignore semantics.
	const ig = ignore.default().add(excludePatterns)

	return (filePath: string): boolean => {
		const relativePath = path.relative(basePath, filePath)
		// `ignore` rejects an empty path; the root itself is never excluded.
		return relativePath !== "" && ig.ignores(relativePath)
	}
}

/**
 * List directory contents with metadata
 */
export async function listDirectory(
	dirPath: string,
	recursive = false,
	excludePatterns: string[] = []
): Promise<FileSystemEntry[]> {
	const entries: FileSystemEntry[] = []

	try {
		// Construct pattern using path.join for proper cross-platform handling
		const pattern = recursive
			? path.join(dirPath, "**/*")
			: path.join(dirPath, "*")

		// glob expects forward slashes, even on Windows
		const normalizedPattern = pattern.replace(/\\/g, "/")

		// Use glob to get all paths (with dot files)
		// Note: We don't use glob's ignore option because it doesn't support gitignore semantics
		const paths = await glob(normalizedPattern, {
			dot: true,
		})

		// Compile the exclude matcher once, then drop excluded paths before
		// stat'ing — so excluded trees (e.g. .pushwork, node_modules) cost
		// only a string match, not a filesystem stat.
		const isExcluded = buildExcludeFilter(dirPath, excludePatterns)
		const kept = paths.filter(filePath => !isExcluded(filePath))

		// Stat with bounded concurrency so a huge tree doesn't open tens of
		// thousands of file descriptors (or buffer everything) at once.
		const allEntries = await mapWithConcurrency(
			kept,
			IO_CONCURRENCY,
			filePath => getFileSystemEntry(filePath)
		)

		// Filter out null entries (files that couldn't be stat'd)
		entries.push(...allEntries.filter((e): e is FileSystemEntry => e !== null))
	} catch {
		// Return empty array if directory doesn't exist or can't be read
	}

	return entries
}

export async function copyFile(
	sourcePath: string,
	destPath: string
): Promise<void> {
	await ensureDirectoryExists(path.dirname(destPath))
	await fs.copyFile(sourcePath, destPath)

	// Preserve file permissions
	const stats = await fs.stat(sourcePath)
	await fs.chmod(destPath, stats.mode)
}

export async function movePath(
	sourcePath: string,
	destPath: string
): Promise<void> {
	await ensureDirectoryExists(path.dirname(destPath))
	await fs.rename(sourcePath, destPath)
}

export function getMimeType(filePath: string): string {
	return mimeTypes.lookup(filePath) || "application/octet-stream"
}

export function getFileExtension(filePath: string): string {
	const ext = path.extname(filePath)
	return ext.startsWith(".") ? ext.slice(1) : ext
}

/**
 * Normalize path separators for cross-platform compatibility
 * Converts all path separators to forward slashes for consistent storage
 */
export function normalizePath(filePath: string): string {
	return path.posix.normalize(filePath.replace(/\\/g, "/"))
}

/**
 * Join paths and normalize separators for cross-platform compatibility
 * Use this instead of string concatenation to ensure proper path handling on Windows
 */
export function joinAndNormalizePath(...paths: string[]): string {
	// Use path.join to properly handle path construction (handles Windows drive letters, etc.)
	const joined = path.join(...paths)
	// Then normalize to forward slashes for consistent storage/comparison
	return normalizePath(joined)
}

/**
 * Get relative path from base directory
 */
export function getRelativePath(basePath: string, filePath: string): string {
	return normalizePath(path.relative(basePath, filePath))
}

/**
 * Format a path as a relative path with proper prefix
 * Ensures paths like "src" become "./src" for clarity
 * Leaves absolute paths and paths already starting with . or .. unchanged
 */
export function formatRelativePath(filePath: string): string {
	// Already starts with . or / - leave as-is
	if (filePath.startsWith(".") || filePath.startsWith("/")) {
		return filePath
	}
	// Add ./ prefix for clarity
	return `./${filePath}`
}
