import { waitForSync } from "../../src/utils/network-sync";
import { DocHandle, StorageId } from "@automerge/automerge-repo";

/**
 * Create a mock DocHandle with controllable heads.
 *
 * @param headSequence - An array of head values the handle returns on
 *   successive calls to heads(). Once exhausted, the last value repeats.
 *   This lets us simulate heads that change (sync in progress) and then
 *   stabilize (sync complete).
 */
function mockHandle(headSequence: string[][]): DocHandle<unknown> {
  let callCount = 0;

  return {
    url: `automerge:mock-${Math.random().toString(36).slice(2)}`,
    heads: () => {
      const idx = Math.min(callCount++, headSequence.length - 1);
      return headSequence[idx];
    },
    // getSyncInfo is only called in the StorageId path, not the head-stability path
    getSyncInfo: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  } as unknown as DocHandle<unknown>;
}

describe("waitForSync (Subduction / head-stability mode)", () => {
  // When syncServerStorageId is undefined, waitForSync should use the
  // head-stability polling path instead of the getSyncInfo-based path.

  it("should return immediately for empty handle list", async () => {
    const result = await waitForSync([], undefined);
    expect(result.failed).toHaveLength(0);
  });

  it("should resolve when handle heads are already stable", async () => {
    // Heads never change — stable from the start
    const handle = mockHandle([["head-a", "head-b"]]);
    const result = await waitForSync([handle], undefined, 5000);

    expect(result.failed).toHaveLength(0);
    // getSyncInfo should never be called in head-stability mode
    expect(handle.getSyncInfo).not.toHaveBeenCalled();
  });

  it("should resolve after heads stabilize", async () => {
    // Heads change for the first few polls, then stabilize
    const handle = mockHandle([
      ["head-1"],   // poll 1: initial
      ["head-2"],   // poll 2: changed (reset stable count)
      ["head-3"],   // poll 3: changed again
      ["head-3"],   // poll 4: stable check 1
      ["head-3"],   // poll 5: stable check 2
      ["head-3"],   // poll 6: stable check 3 → converged
    ]);

    const result = await waitForSync([handle], undefined, 10000);
    expect(result.failed).toHaveLength(0);
  });

  it("should report handle as failed on timeout", async () => {
    // Heads keep changing — never stabilize
    let counter = 0;
    const neverStable = {
      url: "automerge:never-stable",
      heads: () => [`head-${counter++}`],
      getSyncInfo: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as DocHandle<unknown>;

    const result = await waitForSync([neverStable], undefined, 500);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toBe(neverStable);
  });

  it("should handle a mix of stable and unstable handles", async () => {
    const stable = mockHandle([["stable-head"]]);

    let counter = 0;
    const unstable = {
      url: "automerge:unstable",
      heads: () => [`changing-${counter++}`],
      getSyncInfo: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as DocHandle<unknown>;

    const result = await waitForSync([stable, unstable], undefined, 500);

    // The stable handle should succeed, the unstable one should fail
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toBe(unstable);
  });

  it("should not use getSyncInfo when no StorageId is provided", async () => {
    const handle = mockHandle([["head-a"]]);
    await waitForSync([handle], undefined, 5000);

    // The head-stability path does not call getSyncInfo at all
    expect(handle.getSyncInfo).not.toHaveBeenCalled();
  });
});

describe("waitForSync (WebSocket / StorageId mode)", () => {
  // When a StorageId IS provided, waitForSync should use getSyncInfo-based
  // verification instead of head-stability polling.

  it("should use getSyncInfo when StorageId is provided", async () => {
    const storageId = "test-storage-id" as StorageId;
    const heads = ["head-a"];

    const handle = {
      url: "automerge:ws-handle",
      heads: () => heads,
      getSyncInfo: jest.fn().mockReturnValue({ lastHeads: heads }),
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as DocHandle<unknown>;

    const result = await waitForSync([handle], storageId, 5000);

    expect(result.failed).toHaveLength(0);
    expect(handle.getSyncInfo).toHaveBeenCalledWith(storageId);
  });

  it("should detect already-synced handles via getSyncInfo", async () => {
    const storageId = "test-storage-id" as StorageId;
    const heads = ["same-head"];

    const handle = {
      url: "automerge:already-synced",
      heads: () => heads,
      // getSyncInfo returns matching heads → already synced
      getSyncInfo: jest.fn().mockReturnValue({ lastHeads: heads }),
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as DocHandle<unknown>;

    const result = await waitForSync([handle], storageId, 5000);
    expect(result.failed).toHaveLength(0);
  });
});
