import { SyncSnapshot, MoveCandidate } from "../types";
import { isTextFile } from "../utils";
import { stringSimilarity } from "../utils/string-similarity";
import { ChangeType, DetectedChange } from "../types";

/**
 * Simplified move detection engine
 */
export class MoveDetector {
  private readonly moveThreshold: number;

  constructor(moveThreshold: number = 0.7) {
    this.moveThreshold = moveThreshold;
  }

  /**
   * Detect file moves by analyzing deleted and created files
   */
  async detectMoves(
    changes: DetectedChange[],
    snapshot: SyncSnapshot
  ): Promise<{ moves: MoveCandidate[]; remainingChanges: DetectedChange[] }> {
    const deletedFiles = changes.filter(
      (c) => !c.localContent && c.changeType === ChangeType.LOCAL_ONLY
    );
    const createdFiles = changes.filter(
      (c) =>
        c.localContent &&
        c.changeType === ChangeType.LOCAL_ONLY &&
        !snapshot.files.has(c.path)
    );

    if (deletedFiles.length === 0 || createdFiles.length === 0) {
      return { moves: [], remainingChanges: changes };
    }

    const moves: MoveCandidate[] = [];
    const usedCreations = new Set<string>();
    const usedDeletions = new Set<string>();

    // Find potential moves by comparing content
    for (const deletedFile of deletedFiles) {
      const deletedContent = deletedFile.remoteContent;
      if (deletedContent === null) continue;

      let bestMatch: { file: DetectedChange; similarity: number } | null = null;

      for (const createdFile of createdFiles) {
        if (usedCreations.has(createdFile.path)) continue;
        if (createdFile.localContent === null) continue;

        const similarity = await this.calculateSimilarity(
          deletedContent,
          createdFile.localContent,
          deletedFile.path
        );

        if (similarity >= this.moveThreshold) {
          if (!bestMatch || similarity > bestMatch.similarity) {
            bestMatch = { file: createdFile, similarity };
          }
        }
      }

      if (bestMatch) {
        // If we detected a move above threshold, we apply it
        moves.push({
          fromPath: deletedFile.path,
          toPath: bestMatch.file.path,
          similarity: bestMatch.similarity,
          newContent: bestMatch.file.localContent || undefined,
        });

        // Consume the deletion and creation (move replaces both)
        usedCreations.add(bestMatch.file.path);
        usedDeletions.add(deletedFile.path);
      }
    }

    const remainingChanges = changes.filter(
      (change) =>
        !usedCreations.has(change.path) && !usedDeletions.has(change.path)
    );

    return { moves, remainingChanges };
  }

  /**
   * Calculate similarity between two content pieces
   * Optimized for speed while maintaining accuracy
   */
  private async calculateSimilarity(
    content1: string | Uint8Array,
    content2: string | Uint8Array,
    path: string
  ): Promise<number> {
    if (content1 === content2) return 1.0;

    // Early exit: size difference too large
    const size1 =
      typeof content1 === "string" ? content1.length : content1.length;
    const size2 =
      typeof content2 === "string" ? content2.length : content2.length;
    const sizeDiff = Math.abs(size1 - size2) / Math.max(size1, size2);
    if (sizeDiff > 0.5) return 0.0;

    // Binary files: hash mismatch = not a move
    const isText = await isTextFile(path);
    if (!isText) return 0.0;

    // Text files: use string similarity
    const str1 =
      typeof content1 === "string" ? content1 : this.bufferToString(content1);
    const str2 =
      typeof content2 === "string" ? content2 : this.bufferToString(content2);

    // For small files (<4KB), compare full content
    if (size1 < 4096 && size2 < 4096) {
      return stringSimilarity(str1, str2);
    }

    // For large files, sample 3 locations
    const samples1 = this.getSamples(str1);
    const samples2 = this.getSamples(str2);

    let totalSimilarity = 0;
    for (let i = 0; i < Math.min(samples1.length, samples2.length); i++) {
      totalSimilarity += stringSimilarity(samples1[i], samples2[i]);
    }

    return totalSimilarity / Math.min(samples1.length, samples2.length);
  }

  /**
   * Get representative samples from content (beginning, middle, end)
   */
  private getSamples(str: string): string[] {
    const CHUNK_SIZE = 1024;
    const length = str.length;

    if (length <= CHUNK_SIZE) {
      return [str];
    }

    return [
      str.slice(0, CHUNK_SIZE), // Beginning
      str.slice(
        Math.floor(length / 2) - Math.floor(CHUNK_SIZE / 2),
        Math.floor(length / 2) + Math.floor(CHUNK_SIZE / 2)
      ), // Middle
      str.slice(-CHUNK_SIZE), // End
    ];
  }

  /**
   * Convert buffer to string (for text comparison)
   */
  private bufferToString(buffer: Uint8Array): string {
    return new TextDecoder().decode(buffer);
  }

  /**
   * Format move for display
   */
  formatMove(move: MoveCandidate): string {
    const percentage = Math.round(move.similarity * 100);
    return `${move.fromPath} → ${move.toPath} (${percentage}% similar)`;
  }
}
