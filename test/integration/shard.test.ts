/**
 * Correctness guard for the shared-nothing shard worker pools
 * (PUSHWORK_PARALLEL_INGEST=shard): an offline init → copy-storage → clone
 * round-trip must be byte-identical to the source, exercising both the
 * shard-ingest and shard-clone workers.
 *
 * The round-trip runs in a plain-node subprocess (fixtures/shard-roundtrip.ts,
 * type-stripped by Node 24) against the built dist, because the worker scripts
 * must be compiled CommonJS and the Subduction Wasm needs a single consistent
 * module instance — the same reason the bench runs compiled rather than tsx.
 */
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);
const REPO_ROOT = path.join(__dirname, "..", "..");
const FIXTURE = path.join(__dirname, "fixtures", "shard-roundtrip.ts");

beforeAll(async () => {
	await execFileP("pnpm", ["build"], { cwd: REPO_ROOT, timeout: 120_000 });
}, 120_000);

describe("shard parallel ingest/clone", () => {
	it(
		"round-trips a multi-file tree byte-identically (offline)",
		async () => {
			// Throws if the fixture exits non-zero (it asserts byte-identity and
			// the expected file count internally).
			const { stdout } = await execFileP(
				"node",
				["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", FIXTURE],
				{
					env: { ...process.env, PUSHWORK_PARALLEL_INGEST: "shard" },
					timeout: 60_000,
					maxBuffer: 16 * 1024 * 1024,
				},
			);
			expect(stdout).toContain("byte-identical");
		},
		90_000,
	);
});
