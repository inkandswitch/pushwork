import {
  SyncSnapshot,
  MoveCandidate,
  FileType,
  SnapshotFileEntry,
} from "../types";
import { ContentSimilarity, readFileContent, getRelativePath } from "../utils";
import { DetectedChange, ChangeType } from "./change-detection";

/**
 * Move detection engine
 */
export class MoveDetector {
  private static readonly AUTO_THRESHOLD = 0.8;
  private static readonly PROMPT_THRESHOLD = 0.5;

  /**
   * Detect file moves by analyzing deleted and created files
   */
  async detectMoves(
    changes: DetectedChange[],
    snapshot: SyncSnapshot,
    rootPath: string
  ): Promise<{ moves: MoveCandidate[]; remainingChanges: DetectedChange[] }> {
    // Separate deletions and creations
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
      const deletedContent = await this.getDeletedFileContent(
        deletedFile,
        snapshot
      );
      if (!deletedContent) continue;

      let bestMatch: { file: DetectedChange; similarity: number } | null = null;

      for (const createdFile of createdFiles) {
        if (usedCreations.has(createdFile.path)) continue;
        if (!createdFile.localContent) continue;

        const similarity = await ContentSimilarity.calculateSimilarity(
          deletedContent,
          createdFile.localContent
        );

        if (similarity >= MoveDetector.PROMPT_THRESHOLD) {
          if (!bestMatch || similarity > bestMatch.similarity) {
            bestMatch = { file: createdFile, similarity };
          }
        }
      }

      if (bestMatch) {
        const confidence = ContentSimilarity.getConfidenceLevel(
          bestMatch.similarity
        );

        // Always report the potential move (for logging/prompting)
        moves.push({
          fromPath: deletedFile.path,
          toPath: bestMatch.file.path,
          similarity: bestMatch.similarity,
          confidence,
          // Capture new content (may include modifications)
          newContent: bestMatch.file.localContent || undefined,
        });

        // Only consume the deletion/creation pair when we would auto-apply the move.
        // If we only want to prompt, leave the original changes in place so
        // sync can still proceed as delete+create (avoids infinite warning loop).
        if (bestMatch.similarity >= MoveDetector.AUTO_THRESHOLD) {
          usedCreations.add(bestMatch.file.path);
          usedDeletions.add(deletedFile.path);
        }
      }
    }

    // Filter out changes that are part of moves
    const remainingChanges = changes.filter(
      (change) =>
        !usedCreations.has(change.path) && !usedDeletions.has(change.path)
    );

    return { moves, remainingChanges };
  }

  /**
   * Get content of a deleted file from snapshot
   */
  private async getDeletedFileContent(
    deletedFile: DetectedChange,
    snapshot: SyncSnapshot
  ): Promise<string | Uint8Array | null> {
    const snapshotEntry = snapshot.files.get(deletedFile.path);
    if (!snapshotEntry) return null;

    // Return remote content if available, otherwise null
    return deletedFile.remoteContent || null;
  }

  /**
   * Group moves by confidence level
   */
  groupMovesByConfidence(moves: MoveCandidate[]): {
    autoMoves: MoveCandidate[];
    promptMoves: MoveCandidate[];
    lowConfidenceMoves: MoveCandidate[];
  } {
    const autoMoves = moves.filter((m) => m.confidence === "auto");
    const promptMoves = moves.filter((m) => m.confidence === "prompt");
    const lowConfidenceMoves = moves.filter((m) => m.confidence === "low");

    return { autoMoves, promptMoves, lowConfidenceMoves };
  }

  /**
   * Validate move candidates to avoid conflicts
   */
  validateMoves(moves: MoveCandidate[]): {
    validMoves: MoveCandidate[];
    conflicts: Array<{ moves: MoveCandidate[]; reason: string }>;
  } {
    const validMoves: MoveCandidate[] = [];
    const conflicts: Array<{ moves: MoveCandidate[]; reason: string }> = [];

    // Check for multiple sources mapping to same destination
    const destinationMap = new Map<string, MoveCandidate[]>();
    for (const move of moves) {
      if (!destinationMap.has(move.toPath)) {
        destinationMap.set(move.toPath, []);
      }
      destinationMap.get(move.toPath)!.push(move);
    }

    // Check for multiple destinations from same source
    const sourceMap = new Map<string, MoveCandidate[]>();
    for (const move of moves) {
      if (!sourceMap.has(move.fromPath)) {
        sourceMap.set(move.fromPath, []);
      }
      sourceMap.get(move.fromPath)!.push(move);
    }

    for (const move of moves) {
      const destinationConflicts = destinationMap.get(move.toPath)!;
      const sourceConflicts = sourceMap.get(move.fromPath)!;

      if (destinationConflicts.length > 1) {
        conflicts.push({
          moves: destinationConflicts,
          reason: `Multiple files moving to ${move.toPath}`,
        });
      } else if (sourceConflicts.length > 1) {
        conflicts.push({
          moves: sourceConflicts,
          reason: `File ${move.fromPath} has multiple potential destinations`,
        });
      } else {
        validMoves.push(move);
      }
    }

    return { validMoves, conflicts };
  }

  /**
   * Apply move detection heuristics
   */
  applyHeuristics(moves: MoveCandidate[]): MoveCandidate[] {
    return moves
      .filter((move) => {
        // Filter out moves within the same directory unless similarity is very high
        const fromDir = this.getDirectoryPath(move.fromPath);
        const toDir = this.getDirectoryPath(move.toPath);

        if (fromDir === toDir && move.similarity < 0.9) {
          return false;
        }

        // Filter out moves with very different file extensions unless similarity is perfect
        const fromExt = this.getFileExtension(move.fromPath);
        const toExt = this.getFileExtension(move.toPath);

        if (fromExt !== toExt && move.similarity < 1.0) {
          return false;
        }

        return true;
      })
      .sort((a, b) => b.similarity - a.similarity); // Sort by similarity descending
  }

  /**
   * Get directory path from file path
   */
  private getDirectoryPath(filePath: string): string {
    const lastSlash = filePath.lastIndexOf("/");
    return lastSlash >= 0 ? filePath.substring(0, lastSlash) : "";
  }

  /**
   * Get file extension from file path
   */
  private getFileExtension(filePath: string): string {
    const lastDot = filePath.lastIndexOf(".");
    const lastSlash = filePath.lastIndexOf("/");

    if (lastDot > lastSlash && lastDot >= 0) {
      return filePath.substring(lastDot + 1).toLowerCase();
    }

    return "";
  }

  /**
   * Check if a move should be auto-applied
   */
  shouldAutoApply(move: MoveCandidate): boolean {
    return move.confidence === "auto";
  }

  /**
   * Check if a move should prompt the user
   */
  shouldPromptUser(move: MoveCandidate): boolean {
    return move.confidence === "prompt";
  }

  /**
   * Format move for display
   */
  formatMove(move: MoveCandidate): string {
    const percentage = Math.round(move.similarity * 100);
    return `${move.fromPath} → ${move.toPath} (${percentage}% similar)`;
  }

  /**
   * Calculate move statistics
   */
  calculateStats(moves: MoveCandidate[]): {
    total: number;
    auto: number;
    prompt: number;
    averageSimilarity: number;
  } {
    const total = moves.length;
    const auto = moves.filter((m) => m.confidence === "auto").length;
    const prompt = moves.filter((m) => m.confidence === "prompt").length;
    const averageSimilarity =
      total > 0 ? moves.reduce((sum, m) => sum + m.similarity, 0) / total : 0;

    return { total, auto, prompt, averageSimilarity };
  }
}
