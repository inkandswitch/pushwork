/**
 * Tests for `findFileInDirectoryHierarchy`, which returns a tri-state
 * `RemoteLookup`: { kind: "found" | "absent" | "unavailable" }.
 *
 * The distinction matters because destructive operations (e.g. deleting
 * a local file on the basis of remote state) must only act on a
 * confirmed "absent" result, never on "unavailable".
 *
 * We construct a fake Repo that implements only the subset of the
 * interface that `findFileInDirectoryHierarchy` uses (`find<T>(url)`
 * returning a handle with `.doc()`), allowing us to exercise the
 * lookup logic without Wasm or network dependencies.
 */

import { generateAutomergeUrl } from "@automerge/automerge-repo";
import { findFileInDirectoryHierarchy } from "../../src/utils/directory";
import { DirectoryDocument } from "../../src/types";

type FakeDirDoc = DirectoryDocument | undefined | "throw";

class FakeRepo {
  // url (plain, no heads) -> directory document contents, undefined to
  // simulate "not ready", "throw" to simulate repo.find rejection.
  private docs = new Map<string, FakeDirDoc>();

  setDir(url: string, doc: FakeDirDoc) {
    this.docs.set(url, doc);
  }

  async find<T>(url: string): Promise<{ doc(): T | undefined }> {
    const entry = this.docs.get(url);
    if (entry === "throw") {
      throw new Error("document unavailable");
    }
    return {
      doc: () => entry as unknown as T,
    };
  }
}

function mkDir(
  url: string,
  entries: { name: string; type: "file" | "folder"; url: string }[]
): DirectoryDocument {
  return {
    "@patchwork": { type: "folder" },
    name: url,
    title: url,
    docs: entries as any,
  };
}

describe("findFileInDirectoryHierarchy tri-state RemoteLookup", () => {
  // Use generated Automerge URLs because parseAutomergeUrl validates
  // the base58 encoding — arbitrary strings like "automerge:root" fail.
  const ROOT = generateAutomergeUrl();
  const SUB = generateAutomergeUrl();
  const SUB2 = generateAutomergeUrl();
  const FILE = generateAutomergeUrl();

  it("returns {kind: 'found'} when the file is present in the final directory", async () => {
    const repo = new FakeRepo();
    repo.setDir(
      ROOT,
      mkDir("root", [{ name: "foo.txt", type: "file", url: FILE }])
    );

    const result = await findFileInDirectoryHierarchy(
      repo as any,
      ROOT,
      "foo.txt"
    );

    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.entry.name).toBe("foo.txt");
      expect(result.entry.type).toBe("file");
      expect(result.entry.url).toBe(FILE);
    }
  });

  it("returns {kind: 'absent'} when the directory was read but the file is not in it", async () => {
    const repo = new FakeRepo();
    repo.setDir(
      ROOT,
      mkDir("root", [
        { name: "something-else.txt", type: "file", url: FILE },
      ])
    );

    const result = await findFileInDirectoryHierarchy(
      repo as any,
      ROOT,
      "missing.txt"
    );

    expect(result.kind).toBe("absent");
  });

  it("returns {kind: 'unavailable'} when the final directory document is not ready", async () => {
    const repo = new FakeRepo();
    repo.setDir(ROOT, undefined);

    const result = await findFileInDirectoryHierarchy(
      repo as any,
      ROOT,
      "foo.txt"
    );

    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.reason).toMatch(/not ready/i);
    }
  });

  it("returns {kind: 'unavailable'} when repo.find rejects for the final directory", async () => {
    const repo = new FakeRepo();
    repo.setDir(ROOT, "throw");

    const result = await findFileInDirectoryHierarchy(
      repo as any,
      ROOT,
      "foo.txt"
    );

    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.reason).toMatch(/failed to fetch/i);
    }
  });

  it("returns {kind: 'unavailable'} when an intermediate directory is not ready", async () => {
    const repo = new FakeRepo();
    repo.setDir(
      ROOT,
      mkDir("root", [{ name: "sub", type: "folder", url: SUB }])
    );
    repo.setDir(SUB, undefined); // not ready

    const result = await findFileInDirectoryHierarchy(
      repo as any,
      ROOT,
      "sub/foo.txt"
    );

    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.reason).toMatch(/intermediate/i);
    }
  });

  it("returns {kind: 'absent'} when an intermediate folder is missing from its parent (authoritative read)", async () => {
    // Read of root succeeds; root has no "sub" folder entry.
    // From the caller's perspective this is positive evidence that the
    // target path is absent from the remote hierarchy.
    const repo = new FakeRepo();
    repo.setDir(ROOT, mkDir("root", []));

    const result = await findFileInDirectoryHierarchy(
      repo as any,
      ROOT,
      "sub/foo.txt"
    );

    expect(result.kind).toBe("absent");
  });

  it("navigates multi-level directory hierarchies correctly", async () => {
    const repo = new FakeRepo();
    repo.setDir(
      ROOT,
      mkDir("root", [{ name: "a", type: "folder", url: SUB }])
    );
    repo.setDir(
      SUB,
      mkDir("a", [{ name: "b", type: "folder", url: SUB2 }])
    );
    repo.setDir(
      SUB2,
      mkDir("b", [{ name: "c.txt", type: "file", url: FILE }])
    );

    const result = await findFileInDirectoryHierarchy(
      repo as any,
      ROOT,
      "a/b/c.txt"
    );

    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.entry.url).toBe(FILE);
    }
  });

  it("returns a plain object for the found entry (no Automerge proxy leak)", async () => {
    const repo = new FakeRepo();
    repo.setDir(
      ROOT,
      mkDir("root", [{ name: "foo.txt", type: "file", url: FILE }])
    );

    const result = await findFileInDirectoryHierarchy(
      repo as any,
      ROOT,
      "foo.txt"
    );

    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      // The returned entry should be a plain object that doesn't reference
      // the doc's internal representation. Mutating it must not affect
      // the original doc contents.
      result.entry.name = "mutated";
      const second = await findFileInDirectoryHierarchy(
        repo as any,
        ROOT,
        "foo.txt"
      );
      if (second.kind === "found") {
        expect(second.entry.name).toBe("foo.txt");
      }
    }
  });
});
