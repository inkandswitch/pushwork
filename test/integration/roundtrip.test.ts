/**
 * Correctness guard for the offline init → copy-storage → clone round-trip:
 * the cloned tree must be byte-identical to the source (text + binary +
 * nested dirs), exercising the single-repo ingest and bounded-concurrency
 * materialize paths end to end.
 *
 * Runs in a plain-node subprocess (fixtures/init-clone-roundtrip.ts,
 * type-stripped by Node 24) against the built dist, because the Subduction
 * Wasm needs a single consistent module instance — the same reason the bench
 * runs compiled rather than tsx.
 */
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);
const FIXTURE = path.join(__dirname, "fixtures", "init-clone-roundtrip.ts");

// dist/ is built once by test/global-setup.ts.

describe("init/clone round-trip", () => {
	it(
		"round-trips a multi-file tree byte-identically (offline)",
		async () => {
			// Throws if the fixture exits non-zero (it asserts byte-identity and
			// the expected file count internally).
			const { stdout } = await execFileP(
				"node",
				["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", FIXTURE],
				{
					timeout: 60_000,
					maxBuffer: 16 * 1024 * 1024,
				},
			);
			expect(stdout).toContain("byte-identical");
		},
		90_000,
	);
});
