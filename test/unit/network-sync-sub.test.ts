import { waitForSync } from "../../src/utils/network-sync";
import { DocHandle } from "@automerge/automerge-repo";
import { EventEmitter } from "events";

/**
 * waitForSync resolves when EITHER:
 * - a `remote-heads` event reports heads matching the handle's local heads
 *   (strict signal — works in WS mode), OR
 * - the handle's local heads remain unchanged for 3 consecutive polls
 *   (stability fallback — used when the strict signal isn't available, e.g.
 *   Subduction direct-peer connections).
 *
 * Polls happen at 100ms intervals, so stability resolves at ~300ms.
 */

interface FakeHandle extends DocHandle<unknown> {
	setHeads(h: string[]): void;
	emitRemote(h: string[], storageId?: string): void;
}

function mockHandle(initialHeads: string[]): FakeHandle {
	const ee = new EventEmitter();
	let current = initialHeads;
	const handle = {
		url: `automerge:mock-${Math.random().toString(36).slice(2)}`,
		heads: () => current,
		on: ee.on.bind(ee),
		off: ee.off.bind(ee),
		setHeads: (h: string[]) => {
			current = h;
		},
		emitRemote: (h: string[], storageId = "test-storage-id") => {
			ee.emit("remote-heads", { storageId, heads: h, timestamp: Date.now() });
		},
	};
	return handle as unknown as FakeHandle;
}

describe("waitForSync", () => {
	it("returns immediately for empty handle list", async () => {
		const result = await waitForSync([]);
		expect(result.failed).toHaveLength(0);
	});

	it("resolves quickly when a remote-heads event reports matching heads", async () => {
		const handle = mockHandle(["head-a"]);
		const promise = waitForSync([handle], 5000);
		setImmediate(() => handle.emitRemote(["head-a"]));
		const result = await promise;
		expect(result.failed).toHaveLength(0);
	});

	it("ignores remote-heads events whose heads don't match", async () => {
		const handle = mockHandle(["head-a"]);
		const promise = waitForSync([handle], 5000);
		setImmediate(() => {
			handle.emitRemote(["head-stale"]);
			handle.emitRemote(["head-a"]);
		});
		const result = await promise;
		expect(result.failed).toHaveLength(0);
	});

	it("accepts confirmation regardless of which storageId reports it", async () => {
		const handle = mockHandle(["head-a"]);
		const promise = waitForSync([handle], 5000);
		setImmediate(() => handle.emitRemote(["head-a"], "any-other-storage-id"));
		const result = await promise;
		expect(result.failed).toHaveLength(0);
	});

	it("falls back to head stability when no remote-heads event arrives", async () => {
		// Heads never change → resolves via stability after ~300ms.
		const handle = mockHandle(["stable-head"]);
		const result = await waitForSync([handle], 5000);
		expect(result.failed).toHaveLength(0);
	});

	it("times out if heads keep changing and no event confirms", async () => {
		const ee = new EventEmitter();
		let counter = 0;
		const neverStable = {
			url: "automerge:never-stable",
			heads: () => [`head-${counter++}`],
			on: ee.on.bind(ee),
			off: ee.off.bind(ee),
		} as unknown as DocHandle<unknown>;

		const result = await waitForSync([neverStable], 500);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]).toBe(neverStable);
	});

	it("waits for the latest local heads if a merge advances them mid-wait", async () => {
		const handle = mockHandle(["head-a"]);
		const promise = waitForSync([handle], 5000);
		setImmediate(() => {
			handle.setHeads(["head-b"]);
			// Stale event for head-a should be ignored.
			handle.emitRemote(["head-a"]);
			// Confirmation of new heads.
			handle.emitRemote(["head-b"]);
		});
		const result = await promise;
		expect(result.failed).toHaveLength(0);
	});

	it("handles a mix of confirmed and timed-out handles concurrently", async () => {
		const fast = mockHandle(["fast-head"]);

		// Build an unstable handle that never converges.
		const ee = new EventEmitter();
		let counter = 0;
		const slow = {
			url: "automerge:unstable",
			heads: () => [`changing-${counter++}`],
			on: ee.on.bind(ee),
			off: ee.off.bind(ee),
		} as unknown as DocHandle<unknown>;

		const promise = waitForSync([fast, slow], 500);
		setImmediate(() => fast.emitRemote(["fast-head"]));

		const result = await promise;
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]).toBe(slow);
	});
});
