import * as A from "@automerge/automerge";
import {
	BlobMeta,
	CommitId,
	CommitInput,
	LooseCommit,
	MemorySigner,
	MemoryStorage,
	Subduction,
	setSubductionLogLevel,
} from "@automerge/automerge-subduction";
import * as os from "os";
import { inject } from "vitest";
import { newDocumentId, toSedimentreeId } from "../../src/url";

describe("test server", () => {
	setSubductionLogLevel("error");

	it("isolates HOME", () => {
		expect(os.homedir()).toContain("pushwork-test-home-");
	});

	it("relays a doc between two clients", async () => {
		const url = new URL(inject("server"));
		const a = new Subduction({ signer: MemorySigner.generate(), storage: new MemoryStorage() });
		const b = new Subduction({ signer: MemorySigner.generate(), storage: new MemoryStorage() });
		const peerA = await a.connectDiscover(url);
		const peerB = await b.connectDiscover(url);

		const sid = toSedimentreeId(newDocumentId());
		const doc = A.from({ hello: "world" });
		const [meta] = A.getFragmentMetadata(doc, 0);
		const [bytes] = A.bundleFragmentMetadata(doc, [meta]);
		const commit = new LooseCommit(sid, CommitId.fromHexString(meta.head), [], new BlobMeta(bytes));
		await a.storeBuiltBatch(sid, [new CommitInput(commit, bytes)], []);

		const push = await a.syncWithPeer(peerA, sid, false, 3000);
		expect(push.success).toBe(true);
		expect(push.stats.totalSent).toBeGreaterThan(0);

		const pull = await b.syncWithPeer(peerB, sid, false, 3000);
		expect(pull.success).toBe(true);
		expect(pull.stats.totalReceived).toBeGreaterThan(0);
		const [blob] = await b.getBlobs(sid);
		expect(A.loadIncremental(A.init<{ hello: string }>(), blob).hello).toBe("world");

		await a.disconnectAll();
		await b.disconnectAll();
		a.free();
		b.free();
	});
});
