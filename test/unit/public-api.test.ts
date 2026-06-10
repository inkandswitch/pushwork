/**
 * Public library-API surface tests.
 *
 * Regression guard for the "importing the package runs the CLI" bug: the
 * package main (dist/index.js) must be import-safe (no argv parsing, no help
 * output, no process.exit) and must expose a curated, useful API surface.
 *
 * Uses subprocesses (real Node) rather than in-process require so the
 * CJS/ESM Automerge dependency graph loads exactly as it would for a consumer.
 */

import * as path from "path";
import { execFileSync } from "child_process";

const ROOT = path.join(__dirname, "../..");
const DIST_INDEX = path.join(ROOT, "dist/index.js");
const DIST_CLI = path.join(ROOT, "dist/cli.js");

function node(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", args, {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { stdout, status: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ""), status: err.status ?? 1 };
  }
}

describe("public library API", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["build"], { cwd: ROOT, stdio: "pipe" });
  });

  it("require('pushwork') does NOT run the CLI (no help, no non-zero exit)", () => {
    const { stdout, status } = node([
      "-e",
      `const pw = require(${JSON.stringify(DIST_INDEX)});
       process.stdout.write("SENTINEL:" + (typeof pw.SyncEngine));`,
    ]);
    // The user's code after the import must run...
    expect(stdout).toContain("SENTINEL:function");
    // ...and the CLI must not have fired on import.
    expect(stdout).not.toContain("Usage: pushwork");
    expect(status).toBe(0);
  });

  it("exposes the curated public API surface", () => {
    const probe = `
      const pw = require(${JSON.stringify(DIST_INDEX)});
      const fns = ["SyncEngine","SnapshotManager","ChangeDetector","MoveDetector",
                   "ConfigManager","resolveProtocol","pickAvailableBackupPath","createRepo"];
      const out = {};
      for (const k of fns) out[k] = typeof pw[k];
      out.CONFIG_VERSION = pw.CONFIG_VERSION;
      out.DEFAULT_SUBDUCTION_SERVER = pw.DEFAULT_SUBDUCTION_SERVER;
      out.FileType = typeof pw.FileType;
      out.ChangeType = typeof pw.ChangeType;
      // internals should NOT be on the curated top-level surface
      out.spliceText = typeof pw.spliceText;
      out.nukeAndRebuildDocs = typeof pw.nukeAndRebuildDocs;
      console.log("JSON:" + JSON.stringify(out));
    `;
    const { stdout, status } = node(["-e", probe]);
    expect(status).toBe(0);
    const json = JSON.parse(stdout.split("JSON:")[1]);

    // High-level entry points present.
    for (const k of [
      "SyncEngine",
      "SnapshotManager",
      "ChangeDetector",
      "MoveDetector",
      "ConfigManager",
      "resolveProtocol",
      "pickAvailableBackupPath",
      "createRepo", // previously missing from the package surface
    ]) {
      expect(json[k]).toBe("function");
    }
    expect(json.CONFIG_VERSION).toBe(1);
    expect(json.DEFAULT_SUBDUCTION_SERVER).toContain("subduction");
    expect(json.FileType).toBe("object");
    expect(json.ChangeType).toBe("object");

    // Curated: low-level internals are no longer dumped at the top level.
    expect(json.spliceText).toBe("undefined");
    expect(json.nukeAndRebuildDocs).toBe("undefined");
  });

  it("the CLI bin still works when executed directly", () => {
    const { stdout, status } = node([DIST_CLI, "--version"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/pushwork \d+\.\d+\.\d+/);
  });
});
