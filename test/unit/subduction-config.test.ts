import * as path from "path";
import * as fs from "fs/promises";
import * as tmp from "tmp";
import { ConfigManager } from "../../src/core/config";
import {
  CONFIG_VERSION,
  DEFAULT_SUBDUCTION_SERVER,
  DEFAULT_SYNC_SERVER,
} from "../../src/types/config";

describe("Sync backend configuration", () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(async () => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;

    await fs.mkdir(path.join(tmpDir, ".pushwork", "automerge"), {
      recursive: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  describe("Default servers", () => {
    it("Subduction default endpoint", () => {
      expect(DEFAULT_SUBDUCTION_SERVER).toBe(
        "wss://subduction.sync.inkandswitch.com"
      );
    });

    it("Subduction differs from legacy WebSocket server", () => {
      expect(DEFAULT_SUBDUCTION_SERVER).not.toBe(DEFAULT_SYNC_SERVER);
    });
  });

  describe("ConfigManager defaults (Subduction is default)", () => {
    it("default config uses the Subduction server", () => {
      const configManager = new ConfigManager(tmpDir);
      const config = configManager.getDefaultDirectoryConfig();
      expect(config.sync_server).toBe(DEFAULT_SUBDUCTION_SERVER);
    });

    it("default config marks protocol as 'subduction'", () => {
      const configManager = new ConfigManager(tmpDir);
      const config = configManager.getDefaultDirectoryConfig();
      expect(config.protocol).toBe("subduction");
    });

    it("default config has no sync_server_storage_id (Subduction doesn't use one)", () => {
      const configManager = new ConfigManager(tmpDir);
      const config = configManager.getDefaultDirectoryConfig();
      expect(config.sync_server_storage_id).toBeUndefined();
    });

    it("default config stamps CONFIG_VERSION", () => {
      const configManager = new ConfigManager(tmpDir);
      const config = configManager.getDefaultDirectoryConfig();
      expect(config.config_version).toBe(CONFIG_VERSION);
    });
  });

  describe("ConfigManager legacy defaults", () => {
    it("legacy default uses the classic WebSocket server", () => {
      const configManager = new ConfigManager(tmpDir);
      const config =
        configManager.getDefaultDirectoryConfigForProtocol("legacy");
      expect(config.sync_server).toBe(DEFAULT_SYNC_SERVER);
    });

    it("legacy default includes sync_server_storage_id", () => {
      const configManager = new ConfigManager(tmpDir);
      const config =
        configManager.getDefaultDirectoryConfigForProtocol("legacy");
      expect(config.sync_server_storage_id).toBeDefined();
    });

    it("legacy default marks protocol as 'legacy'", () => {
      const configManager = new ConfigManager(tmpDir);
      const config =
        configManager.getDefaultDirectoryConfigForProtocol("legacy");
      expect(config.protocol).toBe("legacy");
    });
  });

  describe("legacy flag option types", () => {
    // The `--legacy` flag lives on init and clone only. sync/watch read
    // the backend choice from persisted config (see setupCommandContext).
    // These tests fail at compile time if the type definitions drift.
    it("InitOptions accepts legacy: true", () => {
      const opts: import("../../src/types/config").InitOptions = {
        legacy: true,
      };
      expect(opts.legacy).toBe(true);
    });

    it("CloneOptions accepts legacy: true", () => {
      const opts: import("../../src/types/config").CloneOptions = {
        legacy: true,
      };
      expect(opts.legacy).toBe(true);
    });

    it("InitOptions.legacy is optional (defaults to undefined)", () => {
      const opts: import("../../src/types/config").InitOptions = {};
      expect(opts.legacy).toBeUndefined();
    });
  });
});
