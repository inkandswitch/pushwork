import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as tmp from "tmp";

const execFilePromise = promisify(execFile);
const PUSHWORK_CLI = path.join(__dirname, "../../dist/cli.js");

async function pushwork(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFilePromise("node", [PUSHWORK_CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        PUSHWORK_SYNC_TIMEOUT_MS: process.env.PUSHWORK_SYNC_TIMEOUT_MS ?? "5000",
        PUSHWORK_BIDIRECTIONAL_SYNC_TIMEOUT_MS:
          process.env.PUSHWORK_BIDIRECTIONAL_SYNC_TIMEOUT_MS ?? "2000",
        PUSHWORK_SYNC_GRACE_MS: process.env.PUSHWORK_SYNC_GRACE_MS ?? "0",
      },
    });
  } catch (error: any) {
    throw new Error(
      `pushwork ${args.join(" ")} failed: ${error.message}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`,
    );
  }
}

async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

describe("Concurrent same-file sync", () => {
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

  it("preserves both peers' concurrent edits to the same text file", async () => {
    const repoA = path.join(tmpDir, "repo-a");
    const repoB = path.join(tmpDir, "repo-b");
    await fs.mkdir(repoA);
    await fs.mkdir(repoB);

    const baseline = [
      "# Inbox",
      "",
      "Quick captures, unprocessed.",
      "",
      "- [ ] Try the Pushwork interop loop end to end",
    ].join("\n");

    await fs.writeFile(path.join(repoA, "inbox.md"), `${baseline}\n`);
    await pushwork(["init", "."], repoA);

    const { stdout: rootUrl } = await pushwork(["url"], repoA);
    await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);

    const primaryMarker = "PRIMARY-CONCURRENT";
    const cloneMarker = "CLONE-CONCURRENT";

    await fs.writeFile(
      path.join(repoA, "inbox.md"),
      `${baseline}\n${primaryMarker}\n`,
    );
    await fs.writeFile(
      path.join(repoB, "inbox.md"),
      `${baseline}\n${cloneMarker}\n`,
    );

    await pushwork(["sync", "--gentle"], repoA);
    await pushwork(["sync", "--gentle"], repoB);

    const repoObserver = path.join(tmpDir, "repo-observer");
    await fs.mkdir(repoObserver);
    await pushwork(["clone", rootUrl.trim(), repoObserver], tmpDir);

    const observerAfterCloneSync = await readFile(path.join(repoObserver, "inbox.md"));
    expect(observerAfterCloneSync).toContain(primaryMarker);
    expect(observerAfterCloneSync).toContain(cloneMarker);

    await pushwork(["sync", "--gentle"], repoA);
    const afterResyncA = await readFile(path.join(repoA, "inbox.md"));
    expect(afterResyncA).toContain(primaryMarker);
    expect(afterResyncA).toContain(cloneMarker);

    await pushwork(["sync", "--gentle"], repoB);

    const finalA = await readFile(path.join(repoA, "inbox.md"));
    const finalB = await readFile(path.join(repoB, "inbox.md"));

    expect(finalA).toContain(primaryMarker);
    expect(finalA).toContain(cloneMarker);
    expect(finalB).toContain(primaryMarker);
    expect(finalB).toContain(cloneMarker);
  }, 60_000);
});
