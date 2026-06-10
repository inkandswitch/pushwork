/**
 * ConfigManager integration (on-disk read/write/merge).
 *
 * Previously this file also contained ~9 tests that exercised Node's `fs`,
 * `Promise.all`, `fs.rename`, and write/read timing with no pushwork code — and
 * a "corrupted snapshot" test that wrote `snapshot.json` but asserted on
 * `config.load()` (which reads `config.json`), so it passed for the wrong
 * reason. Those were removed in the 2026-06 test-review; what remains exercises
 * real `ConfigManager` behavior.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { ConfigManager } from "../../src/core";
import { CONFIG_VERSION, DirectoryConfig } from "../../src/types";

describe("ConfigManager (on-disk integration)", () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(() => {
    cleanup();
  });

  it("round-trips a saved config and stamps the schema version", async () => {
    const configManager = new ConfigManager(tmpDir);

    const testConfig: DirectoryConfig = {
      sync_server: "wss://test.server.com",
      sync_enabled: true,
      exclude_patterns: [".git", "*.tmp"],
      artifact_directories: ["dist"],
      sync: { move_detection_threshold: 0.8 },
    };

    await configManager.save(testConfig);

    const loaded = await configManager.load();
    // save() stamps the current schema version (config versioning, v1.4.0).
    expect(loaded).toEqual({ ...testConfig, config_version: CONFIG_VERSION });
  });

  it("merges local over global (local wins)", async () => {
    const configManager = new ConfigManager(tmpDir);
    await configManager.createDefaultGlobal();

    await configManager.save({
      sync_server: "wss://local.server.com",
      sync_enabled: true,
      exclude_patterns: [".git", "*.tmp"],
      artifact_directories: ["dist"],
      sync: { move_detection_threshold: 0.9 },
    });

    const merged = await configManager.getMerged();
    expect(merged.sync_server).toBe("wss://local.server.com"); // local override
    expect(merged.exclude_patterns).toContain(".git");
    expect(merged.sync?.move_detection_threshold).toBe(0.9);
  });

  it("treats a corrupt config.json as unreadable (load() returns null)", async () => {
    // Targets the real file load() reads (config.json), exercising the
    // parse-failure catch (which warns and falls back — see W3 / config.ts).
    const configManager = new ConfigManager(tmpDir);
    await fs.mkdir(path.join(tmpDir, ".pushwork"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".pushwork", "config.json"),
      "{ this is: not valid json"
    );

    expect(await configManager.load()).toBeNull();
  });
});
