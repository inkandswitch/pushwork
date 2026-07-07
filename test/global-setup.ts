/**
 * Vitest global setup: build dist/ once before any suite runs.
 *
 * Integration suites exercise the compiled CLI (`dist/cli.js`) in
 * subprocesses, so a fresh checkout must build first — previously each suite
 * ran `pnpm build` in its own `beforeAll`, which raced (suites without one
 * could run before dist existed) and required pnpm on PATH. Invoking tsc
 * through Node directly needs neither.
 */
import { execFileSync } from "child_process";
import { createRequire } from "module";
import * as path from "path";

const requireHere = createRequire(__filename);

export default function setup(): void {
	const root = path.join(__dirname, "..");
	const tsc = requireHere.resolve("typescript/lib/tsc.js");
	execFileSync(process.execPath, [tsc, "-p", path.join(root, "tsconfig.json")], {
		stdio: "inherit",
	});
}
