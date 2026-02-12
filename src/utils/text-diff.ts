import * as A from "@automerge/automerge";
import * as diffLib from "diff";

/**
 * Apply a text diff between oldContent and newContent as Automerge splice
 * operations on the given document property path.
 *
 * This preserves the collaborative text CRDT structure by making minimal
 * character-level edits rather than replacing the entire string.
 *
 * @param doc - The Automerge document (inside a change callback)
 * @param path - The property path to the text field, e.g. ["content"]
 * @param oldContent - The previous text content
 * @param newContent - The desired new text content
 */
export function spliceText(
  doc: any,
  path: A.Prop[],
  oldContent: string,
  newContent: string
): void {
  if (oldContent === newContent) return;

  // Fast path: if old is empty, just insert everything
  if (oldContent === "") {
    A.splice(doc, path, 0, 0, newContent);
    return;
  }

  // Fast path: if new is empty, just delete everything
  if (newContent === "") {
    A.splice(doc, path, 0, oldContent.length);
    return;
  }

  const changes = diffLib.diffChars(oldContent, newContent);

  let pos = 0;
  for (const part of changes) {
    if (part.removed) {
      A.splice(doc, path, pos, part.value.length);
      // Don't advance pos — text shifted left after deletion
    } else if (part.added) {
      A.splice(doc, path, pos, 0, part.value);
      pos += part.value.length;
    } else {
      // Unchanged text — just advance the cursor
      pos += part.value.length;
    }
  }
}
