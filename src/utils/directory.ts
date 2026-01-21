import {
  AutomergeUrl,
  Repo,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo";
import { DirectoryDocument } from "../types";

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
 * Find a file in the directory hierarchy by path.
 *
 * IMPORTANT: This function strips heads from all URLs before navigation.
 * This ensures we always see the CURRENT state of directories, not a frozen
 * point-in-time view. This is critical because:
 * 1. Directory documents store versioned URLs for subdirectories
 * 2. These URLs may have been captured when the subdirectory was empty
 * 3. Using versioned URLs would make files appear to not exist
 * 4. This would trigger false "remote deletion" detection
 */
export async function findFileInDirectoryHierarchy(
  repo: Repo,
  directoryUrl: AutomergeUrl,
  filePath: string
): Promise<{ name: string; type: string; url: AutomergeUrl } | null> {
  try {
    const pathParts = filePath.split("/");
    let currentDirUrl = getPlainUrl(directoryUrl);

    // Navigate through directories to find the parent directory
    for (let i = 0; i < pathParts.length - 1; i++) {
      const dirName = pathParts[i];
      const dirHandle = await repo.find<DirectoryDocument>(currentDirUrl);
      const dirDoc = await dirHandle.doc();

      if (!dirDoc) return null;

      const subDirEntry = dirDoc.docs.find(
        (entry: { name: string; type: string; url: AutomergeUrl }) =>
          entry.name === dirName && entry.type === "folder"
      );

      if (!subDirEntry) return null;
      currentDirUrl = getPlainUrl(subDirEntry.url);
    }

    // Now look for the file in the final directory
    const fileName = pathParts[pathParts.length - 1];
    const finalDirHandle = await repo.find<DirectoryDocument>(currentDirUrl);
    const finalDirDoc = await finalDirHandle.doc();

    if (!finalDirDoc) return null;

    const fileEntry = finalDirDoc.docs.find(
      (entry: { name: string; type: string; url: AutomergeUrl }) =>
        entry.name === fileName && entry.type === "file"
    );

    return fileEntry || null;
  } catch (error) {
    // Failed to find file in hierarchy
    return null;
  }
}
