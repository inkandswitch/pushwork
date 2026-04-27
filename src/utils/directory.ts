import {
  AutomergeUrl,
  Repo,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo";
import { DirectoryDocument, DirectoryEntry } from "../types";

/**
 * Get a plain URL (without heads) from any URL.
 * Versioned URLs with heads return view handles, which show a frozen point in time.
 * For internal navigation, we always want to see the CURRENT state of documents.
 */
export function getPlainUrl(url: AutomergeUrl): AutomergeUrl {
  const { documentId } = parseAutomergeUrl(url);
  return stringifyAutomergeUrl({ documentId });
}

/**
 * Result of a remote directory lookup. Distinguishes three cases that
 * callers must handle differently:
 *
 * - `found`: the authoritative directory document was read and the target
 *   file entry was present in it.
 * - `absent`: the authoritative directory document was read and the target
 *   file entry was NOT present in it. This is positive evidence that the
 *   file was removed from the remote directory.
 * - `unavailable`: the lookup could not be completed (document not yet
 *   synced, fetch timed out, parse error, etc.). The caller does NOT know
 *   whether the file is present or absent remotely.
 *
 * Destructive operations (e.g. deleting a local file) must only act on
 * `absent`, never on `unavailable`.
 */
export type RemoteLookup =
  | { kind: "found"; entry: DirectoryEntry }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string };

/**
 * Find a file in the directory hierarchy by path.
 *
 * IMPORTANT: This function strips heads from all URLs before navigation.
 * This ensures we always see the CURRENT state of directories, not a frozen
 * point-in-time view. This is critical because:
 * 1. Directory documents store versioned URLs for subdirectories
 * 2. These URLs may have been captured when the subdirectory was empty
 * 3. Using versioned URLs would make files appear to not exist
 * 4. This would trigger false "remote deletion" detection
 *
 * Returns a tri-state `RemoteLookup`:
 * - `found` when the directory doc was read and the file entry exists
 * - `absent` when the directory doc was read and the file entry does NOT exist
 * - `unavailable` when any directory doc along the path could not be read
 *
 * Never conflates "not in directory" with "could not read directory".
 */
export async function findFileInDirectoryHierarchy(
  repo: Repo,
  directoryUrl: AutomergeUrl,
  filePath: string
): Promise<RemoteLookup> {
  const pathParts = filePath.split("/");
  let currentDirUrl = getPlainUrl(directoryUrl);

  // Navigate through directories to find the parent directory
  for (let i = 0; i < pathParts.length - 1; i++) {
    const dirName = pathParts[i];
    let dirDoc: DirectoryDocument | undefined;

    try {
      const dirHandle = await repo.find<DirectoryDocument>(currentDirUrl);
      dirDoc = dirHandle.doc();
    } catch (error) {
      return {
        kind: "unavailable",
        reason: `failed to fetch intermediate directory at ${pathParts.slice(0, i + 1).join("/")}: ${error}`,
      };
    }

    if (!dirDoc) {
      return {
        kind: "unavailable",
        reason: `intermediate directory not ready at ${pathParts.slice(0, i + 1).join("/")}`,
      };
    }

    const subDirEntry = dirDoc.docs.find(
      (entry: { name: string; type: string; url: AutomergeUrl }) =>
        entry.name === dirName && entry.type === "folder"
    );

    // The directory was read successfully but the intermediate folder is
    // not in its listing. From the caller's perspective this means the
    // target path is absent from the remote hierarchy — whoever was
    // holding it removed the whole parent folder.
    if (!subDirEntry) {
      return { kind: "absent" };
    }
    currentDirUrl = getPlainUrl(subDirEntry.url);
  }

  // Now look for the file in the final directory
  const fileName = pathParts[pathParts.length - 1];
  let finalDirDoc: DirectoryDocument | undefined;

  try {
    const finalDirHandle = await repo.find<DirectoryDocument>(currentDirUrl);
    finalDirDoc = finalDirHandle.doc();
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `failed to fetch parent directory of ${filePath}: ${error}`,
    };
  }

  if (!finalDirDoc) {
    return {
      kind: "unavailable",
      reason: `parent directory not ready for ${filePath}`,
    };
  }

  const fileEntry = finalDirDoc.docs.find(
    (entry: { name: string; type: string; url: AutomergeUrl }) =>
      entry.name === fileName && entry.type === "file"
  );

  if (!fileEntry) {
    return { kind: "absent" };
  }

  // Spread into a plain object so callers never hold onto an Automerge
  // proxy past the dirDoc.docs iteration.
  return {
    kind: "found",
    entry: {
      name: fileEntry.name,
      type: fileEntry.type as "file" | "folder",
      url: fileEntry.url,
    },
  };
}
