import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";

describe("Sync Timing Analysis", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), "sync-timing-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("File Operation Timing", () => {
    it("should measure rapid file operations timing", async () => {
      const startTime = Date.now();

      // Simulate rapid file operations similar to sync
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          fs.writeFile(path.join(testDir, `file${i}.txt`), `content${i}`)
        );
      }

      await Promise.all(promises);
      const totalTime = Date.now() - startTime;

      console.log(`Created 10 files in ${totalTime}ms`);

      // Verify all files exist
      const files = await fs.readdir(testDir);
      expect(files).toHaveLength(10);

      // This test shows us baseline file operation timing
      expect(totalTime).toBeLessThan(1000); // Should be fast for local operations
    });

    it("should measure sequential vs parallel file operations", async () => {
      // Sequential operations
      const sequentialStart = Date.now();
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(path.join(testDir, `seq${i}.txt`), `content${i}`);
      }
      const sequentialTime = Date.now() - sequentialStart;

      // Parallel operations
      const parallelStart = Date.now();
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          fs.writeFile(path.join(testDir, `par${i}.txt`), `content${i}`)
        );
      }
      await Promise.all(promises);
      const parallelTime = Date.now() - parallelStart;

      console.log(
        `Sequential: ${sequentialTime}ms, Parallel: ${parallelTime}ms`
      );

      // Parallel should generally be faster
      expect(parallelTime).toBeLessThanOrEqual(sequentialTime);

      // Verify all files exist
      const files = await fs.readdir(testDir);
      expect(files).toHaveLength(10);
    });

    it("should test file operation atomicity", async () => {
      const filePath = path.join(testDir, "test.txt");

      // Write initial content
      await fs.writeFile(filePath, "initial content");

      // Rapid successive writes to same file
      const writes: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        writes.push(fs.writeFile(filePath, `updated content ${i}`));
      }

      await Promise.all(writes);

      // Check final content (should be one of the updates)
      const finalContent = await fs.readFile(filePath, "utf8");
      expect(finalContent).toMatch(/updated content \d/);

      console.log(`Final content after rapid writes: "${finalContent}"`);
    });
  });

  describe("Sync Completion Scenarios", () => {
    it("should simulate the need for sync completion detection", async () => {
      // This test simulates what might happen with network sync
      // where we need to wait for operations to complete

      const results: { operation: string; time: number }[] = [];

      // Simulate "local" operations (fast)
      const localStart = Date.now();
      await fs.writeFile(path.join(testDir, "local.txt"), "local content");
      const localTime = Date.now() - localStart;
      results.push({ operation: "local write", time: localTime });

      // Simulate "network" operations (slower with artificial delay)
      const networkStart = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 50)); // 50ms delay
      await fs.writeFile(path.join(testDir, "network.txt"), "network content");
      const networkTime = Date.now() - networkStart;
      results.push({ operation: "network write", time: networkTime });

      console.log("Operation timing:");
      results.forEach((r) => {
        console.log(`  ${r.operation}: ${r.time}ms`);
      });

      // This demonstrates why we might need to wait for slower operations
      expect(networkTime).toBeGreaterThan(localTime);
      expect(networkTime).toBeGreaterThan(40); // Should include our delay
    });

    it("should test what happens without proper completion waiting", async () => {
      // Simulate starting an operation but not waiting for it
      const promises: Promise<void>[] = [];

      // Start operations without awaiting
      for (let i = 0; i < 3; i++) {
        promises.push(
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, 10 * i)); // Varying delays
            await fs.writeFile(
              path.join(testDir, `async${i}.txt`),
              `content${i}`
            );
          })()
        );
      }

      // Check immediately (before operations complete)
      const filesImmediate = await fs.readdir(testDir);
      console.log(`Files immediately: ${filesImmediate.length}`);

      // Now wait for operations to complete
      await Promise.all(promises);

      // Check after completion
      const filesAfter = await fs.readdir(testDir);
      console.log(`Files after completion: ${filesAfter.length}`);

      // This shows the difference between checking immediately vs waiting
      expect(filesAfter.length).toBeGreaterThanOrEqual(filesImmediate.length);
      expect(filesAfter).toHaveLength(3);
    });
  });

  describe("Potential Race Conditions", () => {
    it("should test for potential race conditions in file operations", async () => {
      const sharedFile = path.join(testDir, "shared.txt");

      // Multiple operations on the same file
      const operations = [
        fs.writeFile(sharedFile, "operation1"),
        fs.writeFile(sharedFile, "operation2"),
        fs.writeFile(sharedFile, "operation3"),
      ];

      await Promise.all(operations);

      // Only one operation should "win"
      const content = await fs.readFile(sharedFile, "utf8");
      expect(["operation1", "operation2", "operation3"]).toContain(content);

      console.log(`Final content from race condition: "${content}"`);
    });
  });
});
