import { ContentSimilarity } from "../../src/utils/content-similarity";

describe("ContentSimilarity", () => {
  describe("calculateSimilarity", () => {
    it("should return 1.0 for identical strings", async () => {
      const content1 = "Hello, world!";
      const content2 = "Hello, world!";

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      expect(similarity).toBe(1.0);
    });

    it("should return 1.0 for identical binary content", async () => {
      const content1 = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      const content2 = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      expect(similarity).toBe(1.0);
    });

    it("should return 0.0 for very different content sizes", async () => {
      const content1 = "short";
      const content2 = "a".repeat(1000); // Much longer

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      expect(similarity).toBe(0.0);
    });

    it("should return high similarity for slightly different content", async () => {
      const content1 = "Hello, world!";
      const content2 = "Hello, world?";

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      expect(similarity).toBeGreaterThan(0.9);
      expect(similarity).toBeLessThan(1.0);
    });

    it("should return low similarity for very different content", async () => {
      const content1 = "Hello, world!";
      const content2 = "Goodbye, universe!";

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      expect(similarity).toBeLessThan(0.5);
    });

    it("should handle mixed string and binary content", async () => {
      const content1 = "Hello, world!";
      const content2 = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello" in ASCII

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      // Mixed content types (string vs binary) should have low similarity
      // since binary is converted to hex representation for comparison
      expect(similarity).toBe(0.0);
    });

    it("should use sampling for large content", async () => {
      const content1 =
        "a".repeat(10000) + "different middle" + "b".repeat(10000);
      const content2 =
        "a".repeat(10000) + "same middle here" + "b".repeat(10000);

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      // Should still detect high similarity due to matching beginning and end
      expect(similarity).toBeGreaterThan(0.6);
    });

    it("should handle empty content", async () => {
      const content1 = "";
      const content2 = "not empty";

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      expect(similarity).toBe(0.0);
    });

    it("should return 1.0 for both empty content", async () => {
      const content1 = "";
      const content2 = "";

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      expect(similarity).toBe(1.0);
    });
  });

  describe("getConfidenceLevel", () => {
    it("should return auto for high similarity", () => {
      expect(ContentSimilarity.getConfidenceLevel(0.9)).toBe("auto");
      expect(ContentSimilarity.getConfidenceLevel(0.8)).toBe("auto");
    });

    it("should return prompt for medium similarity", () => {
      expect(ContentSimilarity.getConfidenceLevel(0.7)).toBe("prompt");
      expect(ContentSimilarity.getConfidenceLevel(0.5)).toBe("prompt");
    });

    it("should return low for low similarity", () => {
      expect(ContentSimilarity.getConfidenceLevel(0.4)).toBe("low");
      expect(ContentSimilarity.getConfidenceLevel(0.0)).toBe("low");
    });
  });

  describe("shouldAutoApply", () => {
    it("should return true for high similarity", () => {
      expect(ContentSimilarity.shouldAutoApply(0.9)).toBe(true);
      expect(ContentSimilarity.shouldAutoApply(0.8)).toBe(true);
    });

    it("should return false for medium/low similarity", () => {
      expect(ContentSimilarity.shouldAutoApply(0.7)).toBe(false);
      expect(ContentSimilarity.shouldAutoApply(0.5)).toBe(false);
      expect(ContentSimilarity.shouldAutoApply(0.3)).toBe(false);
    });
  });

  describe("shouldPromptUser", () => {
    it("should return true for medium similarity", () => {
      expect(ContentSimilarity.shouldPromptUser(0.7)).toBe(true);
      expect(ContentSimilarity.shouldPromptUser(0.6)).toBe(true);
      expect(ContentSimilarity.shouldPromptUser(0.5)).toBe(true);
    });

    it("should return false for high similarity", () => {
      expect(ContentSimilarity.shouldPromptUser(0.9)).toBe(false);
      expect(ContentSimilarity.shouldPromptUser(0.8)).toBe(false);
    });

    it("should return false for low similarity", () => {
      expect(ContentSimilarity.shouldPromptUser(0.4)).toBe(false);
      expect(ContentSimilarity.shouldPromptUser(0.3)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle Unicode content correctly", async () => {
      const content1 = "🚀 Hello, 世界!";
      const content2 = "🚀 Hello, 世界?";

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      expect(similarity).toBeGreaterThan(0.9);
    });

    it("should handle line breaks and whitespace", async () => {
      const content1 = "Line 1\nLine 2\nLine 3";
      const content2 = "Line 1\r\nLine 2\r\nLine 3";

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      expect(similarity).toBeGreaterThan(0.8);
    });

    it("should handle very small content differences", async () => {
      const content1 = "a";
      const content2 = "b";

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      expect(similarity).toBe(0.0); // Single character, completely different
    });

    it("should handle binary data with patterns", async () => {
      const content1 = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
      const content2 = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x04, 0x05]);

      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );

      expect(similarity).toBeGreaterThan(0.5); // Most bytes are the same
      expect(similarity).toBeLessThan(1.0);
    });
  });

  describe("performance characteristics", () => {
    it("should handle reasonably large files efficiently", async () => {
      const size = 100000; // 100KB
      const content1 = "a".repeat(size);
      const content2 = "a".repeat(size - 10) + "b".repeat(10);

      const startTime = Date.now();
      const similarity = await ContentSimilarity.calculateSimilarity(
        content1,
        content2
      );
      const duration = Date.now() - startTime;

      expect(similarity).toBeGreaterThan(0.8);
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
    }, 10000); // 10 second timeout for this test
  });
});
