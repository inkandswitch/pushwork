import * as path from "path";
import * as fs from "fs/promises";
import * as tmp from "tmp";
import { ConfigManager } from "../../src/core/config";
import { DEFAULT_SUBDUCTION_SERVER, DEFAULT_SYNC_SERVER } from "../../src/types/config";

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
    it("should use the WebSocket server as default sync_server", async () => {
      const configManager = new ConfigManager(tmpDir);
      const config = configManager.getDefaultDirectoryConfig();
      expect(config.sync_server).toBe(DEFAULT_SYNC_SERVER);
    });

    it("should not default to the subduction server", async () => {
      const configManager = new ConfigManager(tmpDir);
      const config = configManager.getDefaultDirectoryConfig();
      expect(config.sync_server).not.toBe(DEFAULT_SUBDUCTION_SERVER);
    });
  });

  describe("sub flag option types", () => {
    // These tests verify that the option interfaces accept `sub`.
    // If the type definitions are wrong, these will fail at compile time.
    it("should accept sub on InitOptions", () => {
      const opts: import("../../src/types/config").InitOptions = { sub: true };
      expect(opts.sub).toBe(true);
    });

    it("should accept sub on SyncOptions", () => {
      const opts: import("../../src/types/config").SyncOptions = { sub: true };
      expect(opts.sub).toBe(true);
    });

    it("should accept sub on CloneOptions", () => {
      const opts: import("../../src/types/config").CloneOptions = { sub: true };
      expect(opts.sub).toBe(true);
    });

    it("should accept sub on WatchOptions", () => {
      const opts: import("../../src/types/config").WatchOptions = { sub: true };
      expect(opts.sub).toBe(true);
    });

    it("should default sub to undefined (not required)", () => {
      const opts: import("../../src/types/config").SyncOptions = {};
      expect(opts.sub).toBeUndefined();
    });
  });
});
