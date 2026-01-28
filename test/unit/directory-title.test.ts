import * as fs from "fs/promises";
import * as path from "path";
import { tmpdir } from "os";
import {
  Repo,
  AutomergeUrl,
  UrlHeads,
} from "@automerge/automerge-repo";
import { DirectoryDocument, DirectoryConfig } from "../../src/types";
import { SyncEngine } from "../../src/core/sync-engine";
import { SnapshotManager } from "../../src/core/snapshot";

jest.mock("../../src/utils/repo-factory", () => ({
  createRepo: jest.fn(),
}));

jest.mock("../../src/utils/output", () => ({
  out: {
    task: jest.fn(),
    update: jest.fn(),
    done: jest.fn(),
    successBlock: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    exit: jest.fn(),
    taskLine: jest.fn(),
    warn: jest.fn(),
    infoBlock: jest.fn(),
    obj: jest.fn(),
    log: jest.fn(),
  },
}));

type StoredDirectoryDoc = {
  doc: DirectoryDocument;
  version: number;
};

class FakeRepo {
  private docs = new Map<AutomergeUrl, StoredDirectoryDoc>();
  private counter = 0;
  shutdown = jest.fn().mockResolvedValue(undefined);
  lastCreatedUrl: AutomergeUrl | null = null;

  create(doc: DirectoryDocument) {
    const url = `automerge://fake-${++this.counter}` as AutomergeUrl;
    const storedDoc: DirectoryDocument = JSON.parse(JSON.stringify(doc));
    this.docs.set(url, { doc: storedDoc, version: 0 });
    this.lastCreatedUrl = url;
    return new FakeHandle(this, url);
  }

  async find(url: AutomergeUrl) {
    if (!this.docs.has(url)) {
      throw new Error(`Document not found for url ${url}`);
    }
    return new FakeHandle(this, url);
  }

  getDocument(url: AutomergeUrl): DirectoryDocument {
    const entry = this.docs.get(url);
    if (!entry) {
      throw new Error(`Document not found for url ${url}`);
    }
    return entry.doc;
  }

  mutate(url: AutomergeUrl, fn: (doc: DirectoryDocument) => void) {
    const entry = this.docs.get(url);
    if (!entry) {
      throw new Error(`Document not found for url ${url}`);
    }
    fn(entry.doc);
    entry.version += 1;
  }

  heads(url: AutomergeUrl): UrlHeads {
    const entry = this.docs.get(url);
    if (!entry) {
      throw new Error(`Document not found for url ${url}`);
    }
    return [`head-${url}-${entry.version}`] as UrlHeads;
  }
}

class FakeHandle {
  constructor(
    private repo: FakeRepo,
    public url: AutomergeUrl
  ) {}

  async doc(): Promise<DirectoryDocument> {
    return this.repo.getDocument(this.url);
  }

  change(mutator: (doc: DirectoryDocument) => void): void {
    this.repo.mutate(this.url, mutator);
  }

  changeAt(_heads: UrlHeads, mutator: (doc: DirectoryDocument) => void): void {
    this.repo.mutate(this.url, mutator);
  }

  heads(): UrlHeads {
    return this.repo.heads(this.url);
  }
}

const { createRepo } = require("../../src/utils/repo-factory") as {
  createRepo: jest.Mock;
};
const { init } = require("../../src/commands") as {
  init: typeof import("../../src/commands").init;
};

const createRepoMock = createRepo;

describe("Directory document titles", () => {
  afterEach(() => {
    createRepoMock.mockReset();
    jest.clearAllMocks();
  });

  it("sets root directory title to the folder name during init", async () => {
    const tempDir = await fs.mkdtemp(path.join(tmpdir(), "pushwork-root-"));
    const fakeRepo = new FakeRepo();
    createRepoMock.mockResolvedValue(fakeRepo as unknown as Repo);

    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined as never));

    try {
      await init(tempDir, {});
    } finally {
      exitSpy.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(createRepoMock).toHaveBeenCalled();
    expect(fakeRepo.lastCreatedUrl).not.toBeNull();
    const createdDoc = fakeRepo.getDocument(fakeRepo.lastCreatedUrl!);
    expect(createdDoc.title).toBe(path.basename(tempDir));
  });

  it("assigns folder titles when creating nested directory documents", async () => {
    const fakeRepo = new FakeRepo();
    const config: DirectoryConfig = {
      sync_enabled: true,
      exclude_patterns: [],
      sync: { move_detection_threshold: 0.5 },
    };
    const rootPath = path.join(tmpdir(), "pushwork-sync-root");
    const syncEngine = new SyncEngine(
      fakeRepo as unknown as Repo,
      rootPath,
      config
    );

    const snapshotManager: SnapshotManager = (syncEngine as any)
      .snapshotManager;
    const snapshot = snapshotManager.createEmpty();

    const rootHandle = fakeRepo.create({
      "@patchwork": { type: "folder" },
      title: path.basename(rootPath),
      docs: [],
    });

    snapshot.rootDirectoryUrl = rootHandle.url;
    snapshotManager.updateDirectoryEntry(snapshot, "", {
      path: rootPath,
      url: rootHandle.url,
      head: rootHandle.heads(),
      entries: [],
    });

    const ensureDirectoryDocument = (syncEngine as any)
      .ensureDirectoryDocument.bind(syncEngine) as (
      currentSnapshot: typeof snapshot,
      directoryPath: string
    ) => Promise<AutomergeUrl>;

    const childUrl = await ensureDirectoryDocument(snapshot, "parent/child");
    expect(childUrl).toBeDefined();

    const parentEntry = snapshot.directories.get("parent");
    const childEntry = snapshot.directories.get("parent/child");

    expect(parentEntry).toBeDefined();
    expect(childEntry).toBeDefined();

    const parentDoc = fakeRepo.getDocument(parentEntry!.url);
    const childDoc = fakeRepo.getDocument(childEntry!.url);

    expect(parentDoc.title).toBe("parent");
    expect(childDoc.title).toBe("child");
  });
});

