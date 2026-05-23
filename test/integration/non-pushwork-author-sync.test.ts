// Set SYNC_SERVER_BIN to the path of an `automerge-repo-sync-server` binary
// to run this suite. Without it the suite is skipped, since the regression
// requires a non-Pushwork author writing to a local sync server.
import * as fs from "fs/promises";
import * as path from "path";
import * as net from "net";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import * as tmp from "tmp";

const execFilePromise = promisify(execFile);
const PUSHWORK_CLI = path.join(__dirname, "../../dist/cli.js");
const MANUAL_WRITER = path.join(__dirname, "support/manual-patchwork-writer.mjs");
const SYNC_SERVER_BIN = process.env.SYNC_SERVER_BIN;

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

async function runWriter(
  action: "init" | "add-second",
  writerDir: string,
  serverUrl: string,
  storageId: string,
): Promise<string> {
  const { stdout } = await execFilePromise("node", [MANUAL_WRITER, action, writerDir, serverUrl, storageId], {
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  return stdout.trim();
}

async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function startSyncServer(stateDir: string): Promise<{
  process: ReturnType<typeof spawn>;
  url: string;
  storageId: string;
}> {
  if (!SYNC_SERVER_BIN) {
    throw new Error("SYNC_SERVER_BIN is not set");
  }
  const port = await getFreePort();
  const url = `ws://localhost:${port}`;
  await fs.mkdir(path.join(stateDir, "data"), { recursive: true });

  const child = spawn(SYNC_SERVER_BIN, [], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(stateDir, "data"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const storageId = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("sync server did not print Storage ID"));
    }, 10_000);

    const onChunk = (chunk: Buffer) => {
      const match = String(chunk).match(/Storage ID:\s*([0-9a-f-]+)/i);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.off("data", onChunk);
      child.stderr.off("data", onChunk);
      resolve(match[1]);
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`sync server exited early (code=${code}, signal=${signal})`));
    });
  });

  return { process: child, url, storageId };
}

async function stopSyncServer(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.killed) return;
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
}

const describeWithSyncServer = SYNC_SERVER_BIN ? describe : describe.skip;

describeWithSyncServer("Non-Pushwork author compatibility", () => {
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

  it("pulls a remote-only incremental new file from a non-Pushwork author into an existing clone", async () => {
    const writerDir = path.join(tmpDir, "writer-repo");
    const repoClone = path.join(tmpDir, "repo-clone");
    const repoObserver = path.join(tmpDir, "repo-observer");
    await fs.mkdir(repoClone);
    await fs.mkdir(repoObserver);

    const server = await startSyncServer(path.join(tmpDir, "sync-server"));
    try {
      const rootUrl = await runWriter("init", writerDir, server.url, server.storageId);

      await pushwork(
        ["clone", "--force", "--sync-server", server.url, server.storageId, "--", rootUrl, repoClone],
        tmpDir,
      );

      await runWriter("add-second", writerDir, server.url, server.storageId);

      await pushwork(
        ["clone", "--force", "--sync-server", server.url, server.storageId, "--", rootUrl, repoObserver],
        tmpDir,
      );

      expect(await readFile(path.join(repoObserver, "alpha", "second.md"))).toBe("second file\n");

      const diffOutput = (await pushwork(["diff", "--name-only"], repoClone)).stdout;
      expect(diffOutput).toContain("alpha/second.md");

      await pushwork(["sync", "--gentle"], repoClone);
      expect(await pathExists(path.join(repoClone, "alpha", "second.md"))).toBe(true);
      expect(await readFile(path.join(repoClone, "alpha", "second.md"))).toBe("second file\n");
    } finally {
      await stopSyncServer(server.process).catch(() => undefined);
    }
  }, 60_000);
});
