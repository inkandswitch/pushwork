import * as path from "path";
import * as fs from "fs/promises";
import * as tmp from "tmp";
import { ConfigManager } from "../../src/core/config";
import {
  DEFAULT_SUBDUCTION_SERVER,
  DEFAULT_SYNC_SERVER,
  DEFAULT_SYNC_SERVER_STORAGE_ID,
  useSubductionBackend,
  subductionFromCliFlags,
} from "../../src/types/config";

describe("Subduction configuration", () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(async () => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;

    // Set up .pushwork directory structure
    await fs.mkdir(path.join(tmpDir, ".pushwork", "automerge"), { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  describe("DEFAULT_SUBDUCTION_SERVER", () => {
    it("should be the subduction sync endpoint", () => {
      expect(DEFAULT_SUBDUCTION_SERVER).toBe("wss://subduction.sync.inkandswitch.com");
    });

    it("should differ from the default WebSocket sync server", () => {
      expect(DEFAULT_SUBDUCTION_SERVER).not.toBe(DEFAULT_SYNC_SERVER);
    });
  });

  describe("ConfigManager defaults", () => {
    it("should use the Subduction server as default sync_server", async () => {
      const configManager = new ConfigManager(tmpDir);
      const config = configManager.getDefaultDirectoryConfig();
      expect(config.sync_server).toBe(DEFAULT_SUBDUCTION_SERVER);
      expect(config.subduction).toBe(true);
    });

    it("should not include a WebSocket storage id by default", async () => {
      const configManager = new ConfigManager(tmpDir);
      const config = configManager.getDefaultDirectoryConfig();
      expect(config.sync_server_storage_id).toBeUndefined();
    });
  });

  describe("useSubductionBackend", () => {
    it("should default to Subduction for new-style config", () => {
      expect(
        useSubductionBackend({
          subduction: true,
          sync_server: DEFAULT_SUBDUCTION_SERVER,
        }),
      ).toBe(true);
    });

    it("should detect legacy WebSocket config without subduction field", () => {
      expect(
        useSubductionBackend({
          sync_server: DEFAULT_SYNC_SERVER,
          sync_server_storage_id: DEFAULT_SYNC_SERVER_STORAGE_ID,
        }),
      ).toBe(false);
    });
  });

  describe("subductionFromCliFlags", () => {
    it("should default to Subduction", () => {
      expect(subductionFromCliFlags({})).toBe(true);
    });

    it("should select WebSocket with --websocket", () => {
      expect(subductionFromCliFlags({ websocket: true })).toBe(false);
    });

    it("should honor deprecated sub: false", () => {
      expect(subductionFromCliFlags({ sub: false })).toBe(false);
    });
  });
});
