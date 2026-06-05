import { waitForSync, __setSedimentreeIdForTests } from "../../src/utils/network-sync";

__setSedimentreeIdForTests(async () => ({
  toString: () => "sedimentree-mock",
}));
import { DocHandle, Repo, StorageId } from "@automerge/automerge-repo";

const VALID_DOC_URL = "automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu";

function mockHandle(url = VALID_DOC_URL): DocHandle<unknown> {
  return {
    url,
    documentId: "4NMNnkMhL8jXrdJ9jamS58PAVdXu",
    heads: () => [["head-a"]],
    getSyncInfo: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
  } as unknown as DocHandle<unknown>;
}

function mockRepo(peerResults: { success: boolean }[]): Repo {
  const syncWithAllPeers = jest.fn().mockResolvedValue({
    entries: () => peerResults,
  });
  return {
    subduction: Promise.resolve({ syncWithAllPeers }),
    flush: jest.fn().mockResolvedValue(undefined),
    networkSubsystem: { whenReady: jest.fn().mockResolvedValue(undefined) },
  } as unknown as Repo;
}

describe("waitForSync (Subduction / syncWithAllPeers mode)", () => {
  it("should return immediately for empty handle list", async () => {
    const repo = mockRepo([]);
    const result = await waitForSync([], undefined, 5000, repo);
    expect(result.failed).toHaveLength(0);
  });

  it("should resolve when syncWithAllPeers reports success", async () => {
    const handle = mockHandle();
    const repo = mockRepo([{ success: true }]);
    const result = await waitForSync([handle], undefined, 5000, repo);

    expect(result.failed).toHaveLength(0);
    expect((await repo.subduction as any).syncWithAllPeers).toHaveBeenCalledTimes(1);
    expect(repo.flush).toHaveBeenCalledWith([handle.documentId]);
    expect(handle.getSyncInfo).not.toHaveBeenCalled();
  });

  it("should fail when no peers are connected", async () => {
    const handle = mockHandle();
    const repo = mockRepo([]);
    const result = await waitForSync([handle], undefined, 400, repo);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toBe(handle);
  });

  it("should fail when all peers report failure", async () => {
    const handle = mockHandle();
    const repo = mockRepo([{ success: false }, { success: false }]);
    const result = await waitForSync([handle], undefined, 400, repo);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toBe(handle);
  });

  it("should fail when syncWithAllPeers throws", async () => {
    const handle = mockHandle();
    const repo = {
      subduction: Promise.resolve({
        syncWithAllPeers: jest.fn().mockRejectedValue(new Error("network down")),
      }),
      flush: jest.fn().mockResolvedValue(undefined),
      networkSubsystem: { whenReady: jest.fn().mockResolvedValue(undefined) },
    } as unknown as Repo;

    const result = await waitForSync([handle], undefined, 400, repo);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toBe(handle);
  });

  it("should require a Repo when no StorageId is provided", async () => {
    const handle = mockHandle();
    await expect(waitForSync([handle], undefined, 5000)).rejects.toThrow(
      /requires a Repo/,
    );
  });
});

describe("waitForSync (WebSocket / StorageId mode)", () => {
  it("should use getSyncInfo when StorageId is provided", async () => {
    const storageId = "test-storage-id" as StorageId;
    const heads = ["head-a"];

    const handle = {
      url: "automerge:ws-handle",
      documentId: "ws-doc",
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
      documentId: "synced-doc",
      heads: () => heads,
      getSyncInfo: jest.fn().mockReturnValue({ lastHeads: heads }),
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as DocHandle<unknown>;

    const result = await waitForSync([handle], storageId, 5000);
    expect(result.failed).toHaveLength(0);
  });
});
