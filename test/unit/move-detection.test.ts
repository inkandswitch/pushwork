/**
 * Move/rename detection (src/core/move-detection.ts) — pushwork's own logic:
 * pair a deleted file with a created file when their content is similar enough,
 * subject to a configurable threshold, a >50%-size-difference early-exit, and a
 * binary short-circuit.
 */

import { MoveDetector } from "../../src/core/move-detection";
import { SnapshotManager } from "../../src/core/snapshot";
import {
  ChangeType,
  DetectedChange,
  FileType,
  SyncSnapshot,
} from "../../src/types";

const emptySnapshot = (): SyncSnapshot =>
  new SnapshotManager("/tmp/move-test").createEmpty();

// NOTE: `detectMoves` decides text-vs-binary from the file *path* (via
// `isTextFile`), not from the `fileType` field — the field below is set only to
// satisfy the required `DetectedChange` shape and is not what's under test.

/** A locally-deleted file: no local content, old content lives in `remoteContent`. */
function deleted(p: string, content: string | Uint8Array): DetectedChange {
  return {
    path: p,
    changeType: ChangeType.LOCAL_ONLY,
    fileType: typeof content === "string" ? FileType.TEXT : FileType.BINARY,
    localContent: null,
    remoteContent: content,
  };
}

/** A locally-created file: new content in `localContent`, not yet tracked. */
function created(p: string, content: string | Uint8Array): DetectedChange {
  return {
    path: p,
    changeType: ChangeType.LOCAL_ONLY,
    fileType: typeof content === "string" ? FileType.TEXT : FileType.BINARY,
    localContent: content,
    remoteContent: null,
  };
}

const V1 = "export const greeting = 'hello world';\nexport const count = 1;\n";
const V2 = "export const greeting = 'hello world';\nexport const count = 2;\n";
const UNRELATED =
  "zzz totally unrelated payload \u0000 of different bytes and words yyy";

describe("MoveDetector.detectMoves", () => {
  it("pairs a high-similarity delete+create as a single move", async () => {
    const det = new MoveDetector(); // default threshold 0.7
    const changes = [deleted("old.txt", V1), created("new.txt", V2)];

    const { moves, remainingChanges } = await det.detectMoves(
      changes,
      emptySnapshot()
    );

    expect(moves).toHaveLength(1);
    expect(moves[0].fromPath).toBe("old.txt");
    expect(moves[0].toPath).toBe("new.txt");
    expect(moves[0].similarity).toBeGreaterThanOrEqual(0.7);
    expect(moves[0].newContent).toBe(V2);
    // Both the delete and the create are consumed by the move.
    expect(remainingChanges).toHaveLength(0);
  });

  it("does NOT pair a low-similarity delete+create (stays delete + create)", async () => {
    const det = new MoveDetector();
    const changes = [deleted("old.txt", V1), created("new.txt", UNRELATED)];

    const { moves, remainingChanges } = await det.detectMoves(
      changes,
      emptySnapshot()
    );

    expect(moves).toHaveLength(0);
    expect(remainingChanges).toHaveLength(2);
  });

  it("never treats binary files as moves, even with identical bytes", async () => {
    const det = new MoveDetector();
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) % 256);
    // `.png` is classified non-text (isTextFile → "image/png"), so
    // calculateSimilarity returns 0.0 regardless of the bytes. Distinct objects
    // with identical content (not reference-equal) confirm it isn't the
    // content1===content2 fast-path doing the rejecting.
    const changes = [
      deleted("a.png", bytes),
      created("b.png", Uint8Array.from(bytes)),
    ];

    const { moves } = await det.detectMoves(changes, emptySnapshot());
    expect(moves).toHaveLength(0);
  });

  it("rejects a move when the size difference exceeds 50% (early exit before similarity)", async () => {
    const det = new MoveDetector();
    // Both all-'x' (max bigram similarity) but 10x size difference → the size
    // guard returns 0 before stringSimilarity is even consulted.
    const changes = [
      deleted("old.txt", "x".repeat(100)),
      created("new.txt", "x".repeat(10)),
    ];

    const { moves } = await det.detectMoves(changes, emptySnapshot());
    expect(moves).toHaveLength(0);
  });

  it("respects the configured threshold", async () => {
    const changes = () => [deleted("old.txt", V1), created("new.txt", V2)];

    const lax = await new MoveDetector(0.7).detectMoves(
      changes(),
      emptySnapshot()
    );
    expect(lax.moves).toHaveLength(1); // ~0.97 similar ≥ 0.7

    const strict = await new MoveDetector(0.99).detectMoves(
      changes(),
      emptySnapshot()
    );
    expect(strict.moves).toHaveLength(0); // ~0.97 similar < 0.99
  });

  it("does nothing when there are no deletions or no creations", async () => {
    const det = new MoveDetector();

    const onlyCreates = [created("a.txt", V1), created("b.txt", V2)];
    const r1 = await det.detectMoves(onlyCreates, emptySnapshot());
    expect(r1.moves).toHaveLength(0);
    expect(r1.remainingChanges).toEqual(onlyCreates);

    const onlyDeletes = [deleted("a.txt", V1)];
    const r2 = await det.detectMoves(onlyDeletes, emptySnapshot());
    expect(r2.moves).toHaveLength(0);
    expect(r2.remainingChanges).toEqual(onlyDeletes);
  });

  it("picks the most-similar creation when MULTIPLE are above threshold", async () => {
    const det = new MoveDetector();
    // Both candidates clear the 0.7 gate (V2 ≈ 0.97, exact V1 = 1.0); the
    // tie-break (`similarity > bestMatch.similarity`) must select the better one.
    const changes = [
      deleted("old.txt", V1),
      created("less.txt", V2), // ~0.97 similar
      created("more.txt", V1), // identical → 1.0 similar
    ];

    const { moves } = await det.detectMoves(changes, emptySnapshot());
    expect(moves).toHaveLength(1);
    expect(moves[0].toPath).toBe("more.txt");
    expect(moves[0].similarity).toBe(1);
  });
});
