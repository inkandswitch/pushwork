/**
 * Integration test for the Phase 5.i user-facing levers:
 *   - `pushwork status --verbose` reports chronically unavailable paths
 *   - `pushwork rm-tracked <path>` removes the tracked entry
 *   - `pushwork rm-tracked <path> --keep-local` preserves the local file
 *
 * We simulate chronic unavailability by directly editing
 * `.pushwork/snapshot.json` to set `consecutiveUnavailableCount` on a
 * tracked file entry. This exercises the user-facing commands without
 * requiring a flaky sync server.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execSync } from "child_process";

describe("chronic-unavailable recovery levers", () => {
  let tmpDir: string;
  let cleanup: () => void;
  const pushworkCmd = `node "${path.join(__dirname, "../../dist/cli.js")}"`;

  beforeAll(() => {
    execSync("pnpm build", {
      cwd: path.join(__dirname, "../.."),
      stdio: "pipe",
    });
  });

  beforeEach(() => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * Load snapshot.json, apply a mutation, and write it back. Useful
   * for seeding test state (consecutiveUnavailableCount, etc).
   */
  async function mutateSnapshot(
    mutator: (raw: any) => void
  ): Promise<void> {
    const snapPath = path.join(tmpDir, ".pushwork", "snapshot.json");
    const raw = JSON.parse(await fs.readFile(snapPath, "utf8"));
    mutator(raw);
    await fs.writeFile(snapPath, JSON.stringify(raw, null, 2), "utf8");
  }

  /**
   * Construct a minimal pushwork state without calling `pushwork init`.
   * We can't rely on the CLI init here because it connects to a real
   * sync server and blocks; this test only exercises local-only
   * commands (status, rm-tracked, resync) so we can fabricate the
   * snapshot directly.
   *
   * The fabricated snapshot has plausible-looking Automerge URLs but
   * no actual documents backing them — commands that don't touch the
   * repo (like rm-tracked on a non-artifact path) work fine.
   */
  async function initTestRepo(files: Record<string, string>): Promise<void> {
    for (const [p, contents] of Object.entries(files)) {
      const full = path.join(tmpDir, p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, contents);
    }

    const pushworkDir = path.join(tmpDir, ".pushwork");
    await fs.mkdir(pushworkDir, { recursive: true });
    await fs.mkdir(path.join(pushworkDir, "automerge"), { recursive: true });

    await fs.writeFile(
      path.join(pushworkDir, "config.json"),
      JSON.stringify(
        {
          sync_enabled: false,
          exclude_patterns: [
            ".git",
            "node_modules",
            "*.tmp",
            ".pushwork",
            ".DS_Store",
          ],
          artifact_directories: ["dist"],
          sync: { move_detection_threshold: 0.7 },
        },
        null,
        2
      )
    );

    // Generate the Automerge URLs via the installed library so they
    // pass validation.
    const { generateAutomergeUrl } = await import("@automerge/automerge-repo");
    const rootUrl = generateAutomergeUrl();

    const fileEntries: Array<[string, unknown]> = [];
    for (const p of Object.keys(files)) {
      fileEntries.push([
        p,
        {
          path: path.join(tmpDir, p),
          url: generateAutomergeUrl(),
          head: [],
          extension: path.extname(p).slice(1),
          mimeType: "text/plain",
        },
      ]);
    }

    await fs.writeFile(
      path.join(pushworkDir, "snapshot.json"),
      JSON.stringify(
        {
          timestamp: Date.now(),
          rootPath: tmpDir,
          rootDirectoryUrl: rootUrl,
          files: fileEntries,
          directories: [],
        },
        null,
        2
      )
    );
  }

  it("status --verbose surfaces paths with non-zero consecutiveUnavailableCount", async () => {
    await initTestRepo({ "chronic.txt": "hello" });

    // Seed a chronic count on chronic.txt.
    await mutateSnapshot(raw => {
      for (const pair of raw.files) {
        const [relPath, entry] = pair;
        if (relPath === "chronic.txt") {
          entry.consecutiveUnavailableCount = 7;
        }
      }
    });

    const output = execSync(`${pushworkCmd} status --verbose "${tmpDir}"`, {
      stdio: "pipe",
      timeout: 30000,
    }).toString("utf8");

    expect(output).toMatch(/CHRONICALLY UNAVAILABLE/);
    expect(output).toMatch(/chronic\.txt/);
    expect(output).toMatch(/7/);
    expect(output).toMatch(/rm-tracked|resync/);
  }, 120000);

  it("rm-tracked removes the entry from the snapshot and the local file by default", async () => {
    await initTestRepo({ "doomed.txt": "bye" });

    execSync(`${pushworkCmd} rm-tracked doomed.txt "${tmpDir}"`, {
      stdio: "pipe",
      timeout: 30000,
    });

    // Snapshot entry gone.
    const snapPath = path.join(tmpDir, ".pushwork", "snapshot.json");
    const snap = JSON.parse(await fs.readFile(snapPath, "utf8"));
    const paths = new Set(snap.files.map((pair: [string, unknown]) => pair[0]));
    expect(paths.has("doomed.txt")).toBe(false);

    // Local file also gone (default behavior).
    await expect(fs.access(path.join(tmpDir, "doomed.txt"))).rejects.toThrow();
  }, 120000);

  it("rm-tracked --keep-local preserves the local file", async () => {
    await initTestRepo({ "stays.txt": "stays here" });

    execSync(
      `${pushworkCmd} rm-tracked stays.txt --keep-local "${tmpDir}"`,
      {
        stdio: "pipe",
        timeout: 30000,
      }
    );

    const snapPath = path.join(tmpDir, ".pushwork", "snapshot.json");
    const snap = JSON.parse(await fs.readFile(snapPath, "utf8"));
    const paths = new Set(snap.files.map((pair: [string, unknown]) => pair[0]));
    expect(paths.has("stays.txt")).toBe(false);

    // Local file preserved.
    const content = await fs.readFile(
      path.join(tmpDir, "stays.txt"),
      "utf8"
    );
    expect(content).toBe("stays here");
  }, 120000);

  it("rm-tracked exits non-zero for an untracked path", async () => {
    await initTestRepo({ "only.txt": "x" });

    let exitCode = 0;
    try {
      execSync(`${pushworkCmd} rm-tracked nonexistent.txt "${tmpDir}"`, {
        stdio: "pipe",
        timeout: 15000,
      });
    } catch (e: any) {
      exitCode = e.status ?? -1;
    }
    expect(exitCode).not.toBe(0);
  }, 60000);
});
