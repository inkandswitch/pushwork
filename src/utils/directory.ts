import { AutomergeUrl, Repo } from "@automerge/automerge-repo";
import { DirectoryDocument } from "../types";

/**
 * Find a file in the directory hierarchy by path
 */
export async function findFileInDirectoryHierarchy(
  repo: Repo,
  directoryUrl: AutomergeUrl,
  filePath: string
): Promise<{ name: string; type: string; url: AutomergeUrl } | null> {
  try {
    const pathParts = filePath.split("/");
    let currentDirUrl = directoryUrl;

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
      currentDirUrl = subDirEntry.url;
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
