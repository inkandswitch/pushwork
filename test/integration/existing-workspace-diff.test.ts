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

describe("Existing-workspace diff", () => {
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

  it("shows remote-only tracked file changes in an existing clone", async () => {
    const repoA = path.join(tmpDir, "repo-a");
    const repoB = path.join(tmpDir, "repo-b");
    const repoObserver = path.join(tmpDir, "repo-observer");
    await fs.mkdir(repoA);
    await fs.mkdir(repoB);
    await fs.mkdir(repoObserver);

    await fs.writeFile(path.join(repoA, "hello.md"), "hello\n");
    await pushwork(["init", "."], repoA);

    const { stdout: rootUrl } = await pushwork(["url"], repoA);
    await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);

    await fs.mkdir(path.join(repoA, "alpha"));
    await fs.writeFile(path.join(repoA, "alpha", "second.md"), "second file\n");
    await pushwork(["sync", "--gentle"], repoA);

    await pushwork(["clone", rootUrl.trim(), repoObserver], tmpDir);
    expect(await readFile(path.join(repoObserver, "alpha", "second.md"))).toBe(
      "second file\n",
    );

    const diffOutput = (await pushwork(["diff"], repoB)).stdout;
    expect(diffOutput).not.toContain("No changes detected");
    expect(diffOutput).toContain("[remote] alpha/second.md");
    expect(diffOutput).toContain("alpha/second.md");
  }, 60_000);

  it("still shows local diffs when the sync server is unreachable", async () => {
    const repo = path.join(tmpDir, "repo-offline");
    await fs.mkdir(repo);

    const previousSyncTimeout = process.env.PUSHWORK_SYNC_TIMEOUT_MS;
    const previousBidirectionalTimeout = process.env.PUSHWORK_BIDIRECTIONAL_SYNC_TIMEOUT_MS;
    process.env.PUSHWORK_SYNC_TIMEOUT_MS = "1000";
    process.env.PUSHWORK_BIDIRECTIONAL_SYNC_TIMEOUT_MS = "500";

    try {
      await fs.writeFile(path.join(repo, "hello.md"), "hello\n");
      await pushwork(["init", "."], repo);

      const configPath = path.join(repo, ".pushwork", "config.json");
      const config = JSON.parse(await readFile(configPath));
      config.sync_server = "ws://127.0.0.1:1";
      config.sync_server_storage_id = "00000000-0000-0000-0000-000000000000";
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      await fs.writeFile(path.join(repo, "hello.md"), "hello\nlocal change\n");

      const diffOutput = (await pushwork(["diff"], repo)).stdout;
      expect(diffOutput).not.toContain("No changes detected");
      expect(diffOutput).toContain("[local]  hello.md");
      expect(diffOutput).toContain("local change");
    } finally {
      if (previousSyncTimeout === undefined) {
        delete process.env.PUSHWORK_SYNC_TIMEOUT_MS;
      } else {
        process.env.PUSHWORK_SYNC_TIMEOUT_MS = previousSyncTimeout;
      }

      if (previousBidirectionalTimeout === undefined) {
        delete process.env.PUSHWORK_BIDIRECTIONAL_SYNC_TIMEOUT_MS;
      } else {
        process.env.PUSHWORK_BIDIRECTIONAL_SYNC_TIMEOUT_MS = previousBidirectionalTimeout;
      }
    }
  }, 60_000);
});
