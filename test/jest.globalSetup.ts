/**
 * Jest globalSetup — runs once before any test workers spawn.
 *
 * Builds the CLI bundle (dist/cli.js) that several integration tests shell
 * out to. Centralizing the build here avoids two distinct hazards:
 *
 *   1. Multiple test files used to call `execSync("pnpm build")` from their
 *      own `beforeAll` hooks. When Jest ran those files in parallel workers,
 *      concurrent `tsc` invocations would race on writes to `dist/`, which
 *      manifested as a "Converting circular structure to JSON" failure
 *      coming from jest-worker's IPC serialization layer (the underlying
 *      build error contained non-serializable handles).
 *
 *   2. Other integration tests (in-memory-sync, fuzzer, etc.) shell out to
 *      `dist/cli.js` without doing their own build, so they implicitly
 *      assumed something else had already built. Now they can rely on it.
 *
 * In CI the workflow runs `pnpm build` explicitly before `pnpm test:*`, but
 * keeping the build here makes `pnpm test` work locally without a separate
 * build step.
 */
import { execSync } from "child_process";
import { existsSync } from "fs";
import * as path from "path";

export default function globalSetup(): void {
  const repoRoot = path.join(__dirname, "..");
  const cliBundle = path.join(repoRoot, "dist", "cli.js");

  // Allow opting out — useful when iterating on a test that doesn't touch
  // the CLI and you've already built. `JEST_SKIP_BUILD=1 pnpm test ...`.
  if (process.env.JEST_SKIP_BUILD === "1" && existsSync(cliBundle)) {
    return;
  }

  execSync("pnpm build", { cwd: repoRoot, stdio: "pipe" });
}
