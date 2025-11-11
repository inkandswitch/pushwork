import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { GlobalConfig, DirectoryConfig } from "../types";
import { pathExists, ensureDirectoryExists } from "../utils";

/**
 * Configuration manager for pushwork
 */
export class ConfigManager {
  private static readonly GLOBAL_CONFIG_DIR = ".pushwork";
  private static readonly CONFIG_FILENAME = "config.json";
  private static readonly LOCAL_CONFIG_DIR = ".pushwork";

  constructor(private workingDir?: string) {}

  /**
   * Get global configuration path
   */
  private getGlobalConfigPath(): string {
    return path.join(
      os.homedir(),
      ConfigManager.GLOBAL_CONFIG_DIR,
      ConfigManager.CONFIG_FILENAME
    );
  }

  /**
   * Get local configuration path
   */
  private getLocalConfigPath(): string {
    if (!this.workingDir) {
      throw new Error("Working directory not set for local config");
    }
    return path.join(
      this.workingDir,
      ConfigManager.LOCAL_CONFIG_DIR,
      ConfigManager.CONFIG_FILENAME
    );
  }

  /**
   * Load global configuration
   */
  async loadGlobal(): Promise<GlobalConfig | null> {
    try {
      const configPath = this.getGlobalConfigPath();
      if (!(await pathExists(configPath))) {
        return null;
      }

      const content = await fs.readFile(configPath, "utf8");
      return JSON.parse(content) as GlobalConfig;
    } catch (error) {
      // Failed to load global config
      return null;
    }
  }

  /**
   * Save global configuration
   */
  async saveGlobal(config: GlobalConfig): Promise<void> {
    try {
      const configPath = this.getGlobalConfigPath();
      await ensureDirectoryExists(path.dirname(configPath));

      const content = JSON.stringify(config, null, 2);
      await fs.writeFile(configPath, content, "utf8");
    } catch (error) {
      throw new Error(`Failed to save global config: ${error}`);
    }
  }

  /**
   * Load local/directory configuration
   */
  async load(): Promise<DirectoryConfig | null> {
    if (!this.workingDir) {
      return null;
    }

    try {
      const configPath = this.getLocalConfigPath();
      if (!(await pathExists(configPath))) {
        return null;
      }

      const content = await fs.readFile(configPath, "utf8");
      return JSON.parse(content) as DirectoryConfig;
    } catch (error) {
      // Failed to load local config
      return null;
    }
  }

  /**
   * Save local/directory configuration
   */
  async save(config: DirectoryConfig): Promise<void> {
    if (!this.workingDir) {
      throw new Error("Working directory not set for local config");
    }

    try {
      const configPath = this.getLocalConfigPath();
      await ensureDirectoryExists(path.dirname(configPath));

      const content = JSON.stringify(config, null, 2);
      await fs.writeFile(configPath, content, "utf8");
    } catch (error) {
      throw new Error(`Failed to save local config: ${error}`);
    }
  }

  /**
   * Get merged configuration (global + local)
   */
  async getMerged(): Promise<DirectoryConfig> {
    const globalConfig = await this.loadGlobal();
    const localConfig = await this.load();

    // Create default configuration
    const defaultConfig: DirectoryConfig = {
      sync_enabled: true,
      sync_server_storage_id: "3760df37-a4c6-4f66-9ecd-732039a9385d",
      defaults: {
        exclude_patterns: [".git", "node_modules", "*.tmp", ".pushwork"],
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

    // Merge configurations: default < global < local
    let merged = { ...defaultConfig };

    if (globalConfig) {
      merged = this.mergeConfigs(merged, globalConfig);
    }

    if (localConfig) {
      merged = this.mergeConfigs(merged, localConfig);
    }

    return merged;
  }

  /**
   * Merge two configuration objects
   */
  private mergeConfigs(
    base: DirectoryConfig,
    override: Partial<DirectoryConfig> | GlobalConfig
  ): DirectoryConfig {
    const merged = { ...base };

    if ("sync_server" in override && override.sync_server !== undefined) {
      merged.sync_server = override.sync_server;
    }

    if (
      "sync_server_storage_id" in override &&
      override.sync_server_storage_id !== undefined
    ) {
      merged.sync_server_storage_id = override.sync_server_storage_id;
    }

    if ("sync_enabled" in override && override.sync_enabled !== undefined) {
      merged.sync_enabled = override.sync_enabled;
    }

    // Handle GlobalConfig structure
    if ("exclude_patterns" in override && override.exclude_patterns) {
      merged.defaults.exclude_patterns = override.exclude_patterns;
    }

    if ("large_file_threshold" in override && override.large_file_threshold) {
      merged.defaults.large_file_threshold = override.large_file_threshold;
    }

    // Handle DirectoryConfig structure
    if ("defaults" in override && override.defaults) {
      merged.defaults = { ...merged.defaults, ...override.defaults };
    }

    if ("diff" in override && override.diff) {
      // Merge diff settings, ensuring show_binary has a default
      merged.diff = {
        ...merged.diff,
        ...override.diff,
        show_binary: override.diff.show_binary ?? merged.diff.show_binary,
      };
    }

    if ("sync" in override && override.sync) {
      merged.sync = { ...merged.sync, ...override.sync };
    }

    return merged;
  }

  /**
   * Create default global configuration
   */
  async createDefaultGlobal(): Promise<void> {
    const defaultGlobal: GlobalConfig = {
      exclude_patterns: [
        ".git",
        "node_modules",
        "*.tmp",
        ".DS_Store",
        ".pushwork",
      ],
      large_file_threshold: "100MB",
      sync_server: "wss://sync3.automerge.org",
      sync_server_storage_id: "3760df37-a4c6-4f66-9ecd-732039a9385d",
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

    await this.saveGlobal(defaultGlobal);
  }

  /**
   * Check if global configuration exists
   */
  async globalConfigExists(): Promise<boolean> {
    return await pathExists(this.getGlobalConfigPath());
  }

  /**
   * Check if local configuration exists
   */
  async localConfigExists(): Promise<boolean> {
    if (!this.workingDir) return false;
    return await pathExists(this.getLocalConfigPath());
  }

  /**
   * Get configuration value by path (e.g., 'sync.auto_sync')
   */
  async getValue(keyPath: string): Promise<any> {
    const config = await this.getMerged();

    const keys = keyPath.split(".");
    let value: any = config;

    for (const key of keys) {
      if (value && typeof value === "object" && key in value) {
        value = value[key];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Set configuration value by path
   */
  async setValue(keyPath: string, value: any): Promise<void> {
    const config = (await this.load()) || ({} as DirectoryConfig);

    const keys = keyPath.split(".");
    let current: any = config;

    // Navigate to the parent of the target key
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key];
    }

    // Set the value
    const finalKey = keys[keys.length - 1];
    current[finalKey] = value;

    await this.save(config);
  }

  /**
   * Validate configuration
   */
  validate(config: DirectoryConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (config.sync?.move_detection_threshold !== undefined) {
      if (
        config.sync.move_detection_threshold < 0 ||
        config.sync.move_detection_threshold > 1
      ) {
        errors.push("move_detection_threshold must be between 0 and 1");
      }
    }

    if (config.sync?.prompt_threshold !== undefined) {
      if (
        config.sync.prompt_threshold < 0 ||
        config.sync.prompt_threshold > 1
      ) {
        errors.push("prompt_threshold must be between 0 and 1");
      }
    }

    if (config.sync?.parallel_operations !== undefined) {
      if (config.sync.parallel_operations < 1) {
        errors.push("parallel_operations must be at least 1");
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
