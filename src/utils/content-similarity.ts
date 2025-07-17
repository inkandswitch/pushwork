import { calculateContentHash } from "./fs";

/**
 * Content similarity calculation for move detection
 */
export class ContentSimilarity {
  private static readonly CHUNK_SIZE = 1024; // 1KB chunks for sampling
  private static readonly AUTO_THRESHOLD = 0.8;
  private static readonly PROMPT_THRESHOLD = 0.5;

  /**
   * Calculate similarity between two content pieces
   */
  static async calculateSimilarity(
    content1: string | Uint8Array,
    content2: string | Uint8Array
  ): Promise<number> {
    // Quick early exit for identical content
    if (await this.areIdentical(content1, content2)) {
      return 1.0;
    }

    // Size-based quick rejection
    const size1 =
      typeof content1 === "string" ? content1.length : content1.length;
    const size2 =
      typeof content2 === "string" ? content2.length : content2.length;
    const sizeDiff = Math.abs(size1 - size2) / Math.max(size1, size2);

    if (sizeDiff > 0.5) {
      return 0.0; // Too different in size
    }

    // For small files, use full content comparison
    if (size1 < this.CHUNK_SIZE * 4 && size2 < this.CHUNK_SIZE * 4) {
      return this.calculateFullSimilarity(content1, content2);
    }

    // For large files, use sampling
    return this.calculateSampledSimilarity(content1, content2);
  }

  /**
   * Check if two content pieces are identical
   */
  private static async areIdentical(
    content1: string | Uint8Array,
    content2: string | Uint8Array
  ): Promise<boolean> {
    const hash1 = await calculateContentHash(content1);
    const hash2 = await calculateContentHash(content2);
    return hash1 === hash2;
  }

  /**
   * Calculate similarity for small files using full content
   */
  private static calculateFullSimilarity(
    content1: string | Uint8Array,
    content2: string | Uint8Array
  ): number {
    const str1 =
      typeof content1 === "string" ? content1 : this.bufferToString(content1);
    const str2 =
      typeof content2 === "string" ? content2 : this.bufferToString(content2);

    return this.levenshteinSimilarity(str1, str2);
  }

  /**
   * Calculate similarity for large files using sampling
   */
  private static calculateSampledSimilarity(
    content1: string | Uint8Array,
    content2: string | Uint8Array
  ): number {
    const samples1 = this.getSamples(content1);
    const samples2 = this.getSamples(content2);

    let totalSimilarity = 0;
    let comparisons = 0;

    for (let i = 0; i < Math.min(samples1.length, samples2.length); i++) {
      totalSimilarity += this.levenshteinSimilarity(samples1[i], samples2[i]);
      comparisons++;
    }

    return comparisons > 0 ? totalSimilarity / comparisons : 0;
  }

  /**
   * Get representative samples from content
   */
  private static getSamples(content: string | Uint8Array): string[] {
    const str =
      typeof content === "string" ? content : this.bufferToString(content);
    const length = str.length;
    const samples: string[] = [];

    if (length <= this.CHUNK_SIZE) {
      samples.push(str);
      return samples;
    }

    // Beginning
    samples.push(str.slice(0, this.CHUNK_SIZE));

    // Middle
    const midStart = Math.floor(length / 2) - Math.floor(this.CHUNK_SIZE / 2);
    samples.push(str.slice(midStart, midStart + this.CHUNK_SIZE));

    // End
    samples.push(str.slice(-this.CHUNK_SIZE));

    return samples;
  }

  /**
   * Calculate Levenshtein similarity (0-1 scale)
   */
  private static levenshteinSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;

    const distance = this.levenshteinDistance(str1, str2);
    const maxLength = Math.max(str1.length, str2.length);

    return 1 - distance / maxLength;
  }

  /**
   * Calculate Levenshtein distance
   */
  private static levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1)
      .fill(null)
      .map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1, // deletion
          matrix[j - 1][i] + 1, // insertion
          matrix[j - 1][i - 1] + indicator // substitution
        );
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Convert buffer to string for comparison
   */
  private static bufferToString(buffer: Uint8Array): string {
    // For binary content, use hex representation for comparison
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Determine confidence level based on similarity score
   */
  static getConfidenceLevel(similarity: number): "auto" | "prompt" | "low" {
    if (similarity >= this.AUTO_THRESHOLD) {
      return "auto";
    } else if (similarity >= this.PROMPT_THRESHOLD) {
      return "prompt";
    } else {
      return "low";
    }
  }

  /**
   * Should auto-apply move based on similarity
   */
  static shouldAutoApply(similarity: number): boolean {
    return similarity >= this.AUTO_THRESHOLD;
  }

  /**
   * Should prompt user for move confirmation
   */
  static shouldPromptUser(similarity: number): boolean {
    return (
      similarity >= this.PROMPT_THRESHOLD && similarity < this.AUTO_THRESHOLD
    );
  }
}
