import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";

// These talk to every connected peer, which would bypass the per-peer allowlist.
const BROADCAST =
	/\.(syncWithAllPeers|fullSyncWithPeer|fullSyncWithAllPeers|addBatch|addCommit|addCommitsBatch|addFragment|addFragmentsBatch|addSedimentree)\(/;

describe("no broadcast", () => {
	it("never calls a Subduction method that talks to every peer", async () => {
		const root = path.resolve(__dirname, "../../src");
		const files = (await fs.readdir(root, { recursive: true })).filter(f => f.endsWith(".ts"));
		const bad: string[] = [];
		for (const f of files) {
			if (BROADCAST.test(await fs.readFile(path.join(root, f), "utf8"))) bad.push(f);
		}
		expect(bad, `broadcasting calls in: ${bad.join(", ")}`).toEqual([]);
	});
});
