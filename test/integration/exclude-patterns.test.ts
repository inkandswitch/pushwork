import * as path from "path";
import * as fs from "fs/promises";
import { tmpdir } from "os";
import { ConfigManager } from "../../src/config";
import { DirectoryConfig } from "../../src/types";
import {
  ensureDirectoryExists,
  writeFileContent,
  listDirectory,
} from "../../src/utils";

describe("Exclude Patterns", () => {
  let tmpDir: string;
  let syncToolDir: string;
  let configManager: ConfigManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(tmpdir(), "sync-test-"));
    syncToolDir = path.join(tmpDir, ".sync-tool");
    await ensureDirectoryExists(syncToolDir);
    await ensureDirectoryExists(path.join(syncToolDir, "automerge"));

    configManager = new ConfigManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should exclude .sync-tool directory from filesystem listing", async () => {
    // Create files both inside and outside .sync-tool directory
    await writeFileContent(
      path.join(tmpDir, "regular-file.txt"),
      "regular content"
    );
    await writeFileContent(
      path.join(tmpDir, "another-file.md"),
      "markdown content"
    );
    await writeFileContent(
      path.join(syncToolDir, "snapshot.json"),
      '{"timestamp": 123}'
    );
    await writeFileContent(
      path.join(syncToolDir, "config.json"),
      '{"test": true}'
    );

    // Create nested directory with file inside .sync-tool
    const nestedDir = path.join(syncToolDir, "nested");
    await ensureDirectoryExists(nestedDir);
    await writeFileContent(
      path.join(nestedDir, "internal.log"),
      "internal log data"
    );

    // Test listDirectory with exclude patterns
    const excludePatterns = [".sync-tool"];
    const entries = await listDirectory(tmpDir, true, excludePatterns);

    // Verify that .sync-tool files are excluded
    const filePaths = entries.map((entry) => path.relative(tmpDir, entry.path));

    expect(filePaths).toContain("regular-file.txt");
    expect(filePaths).toContain("another-file.md");
    expect(filePaths).not.toContain(".sync-tool/snapshot.json");
    expect(filePaths).not.toContain(".sync-tool/config.json");
    expect(filePaths).not.toContain(".sync-tool/nested/internal.log");
  });

  it("should exclude files matching glob patterns", async () => {
    // Create files that should and shouldn't be excluded
    await writeFileContent(path.join(tmpDir, "include.txt"), "include me");
    await writeFileContent(path.join(tmpDir, "exclude.tmp"), "exclude me");
    await writeFileContent(path.join(tmpDir, "debug.log"), "exclude me too");
    await writeFileContent(path.join(tmpDir, "readme.md"), "include me");

    // Create node_modules directory with files
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    await ensureDirectoryExists(nodeModulesDir);
    await writeFileContent(
      path.join(nodeModulesDir, "package.json"),
      "exclude me"
    );

    // Test listDirectory with various exclude patterns
    const excludePatterns = ["*.tmp", "*.log", "node_modules", ".sync-tool"];
    const entries = await listDirectory(tmpDir, true, excludePatterns);

    // Verify correct files are included/excluded
    const filePaths = entries.map((entry) => path.relative(tmpDir, entry.path));

    expect(filePaths).toContain("include.txt");
    expect(filePaths).toContain("readme.md");
    expect(filePaths).not.toContain("exclude.tmp");
    expect(filePaths).not.toContain("debug.log");
    expect(filePaths).not.toContain("node_modules/package.json");
  });

  it("should use merged configuration exclude patterns", async () => {
    // Create global config
    await configManager.createDefaultGlobal();

    // Create local config with additional exclude patterns
    const localConfig: DirectoryConfig = {
      sync_server: "wss://test.server.com",
      sync_enabled: true,
      defaults: {
        exclude_patterns: [".git", "*.tmp", ".sync-tool", "*.env"],
        large_file_threshold: "100MB",
      },
      diff: {
        show_binary: false,
      },
      sync: {
        move_detection_threshold: 0.8,
        prompt_threshold: 0.5,
        auto_sync: false,
        parallel_operations: 4,
      },
    };
    await configManager.save(localConfig);

    // Get merged config
    const mergedConfig = await configManager.getMerged();

    // Verify .sync-tool is in the exclude patterns
    expect(mergedConfig.defaults.exclude_patterns).toContain(".sync-tool");
    expect(mergedConfig.defaults.exclude_patterns).toContain("*.env");
    expect(mergedConfig.defaults.exclude_patterns).toContain(".git");

    // Create test files
    await writeFileContent(path.join(tmpDir, "include.txt"), "include me");
    await writeFileContent(path.join(tmpDir, "secret.env"), "exclude me");
    await writeFileContent(
      path.join(syncToolDir, "snapshot.json"),
      "exclude me"
    );

    // Test with merged exclude patterns
    const entries = await listDirectory(
      tmpDir,
      true,
      mergedConfig.defaults.exclude_patterns
    );
    const filePaths = entries.map((entry) => path.relative(tmpDir, entry.path));

    expect(filePaths).toContain("include.txt");
    expect(filePaths).not.toContain("secret.env");
    expect(filePaths).not.toContain(".sync-tool/snapshot.json");
  });
});
