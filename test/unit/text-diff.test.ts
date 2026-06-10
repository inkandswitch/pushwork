/**
 * Character-level CRDT text editing (src/utils/text-diff.ts).
 *
 * NOTE: this tests *our* glue, not the `diff` library or Automerge. `spliceText`
 * hand-rolls the translation of `diffChars` output into a sequence of `A.splice`
 * calls with manual cursor tracking (the `pos` / removed / added arithmetic — the
 * "don't advance pos after a deletion" logic). That arithmetic is the bug-prone
 * part and is what the round-trip property exercises: if our cursor handling is
 * wrong, `applySplice(a, b) !== b`. `updateTextContent`'s legacy-ImmutableString
 * branch and `readDocContent`'s normalization are likewise our own dispatch.
 * Previously untested.
 */

import * as A from "@automerge/automerge";
import * as fc from "fast-check";
import {
  spliceText,
  updateTextContent,
  readDocContent,
} from "../../src/utils/text-diff";

/** Apply spliceText(a -> b) to a fresh doc and return the resulting content. */
function applySplice(a: string, b: string): string {
  let doc = A.from<{ content: string }>({ content: a });
  doc = A.change(doc, (d) => spliceText(d, ["content"], a, b));
  return doc.content;
}

describe("spliceText", () => {
  it("property: applying spliceText(a -> b) yields exactly b", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => applySplice(a, b) === b),
      { numRuns: 300 }
    );
  });

  it("property holds for unicode / multibyte / emoji content", () => {
    const arb = fc
      .array(fc.constantFrom("a", "é", "ü", "—", "🎉", "🚀", "日", "\n", " "), {
        maxLength: 40,
      })
      .map((cs) => cs.join(""));
    fc.assert(
      fc.property(arb, arb, (a, b) => applySplice(a, b) === b),
      { numRuns: 300 }
    );
  });

  it("insert into empty, delete to empty, and no-op", () => {
    expect(applySplice("", "hello")).toBe("hello");
    expect(applySplice("hello", "")).toBe("");
    expect(applySplice("same", "same")).toBe("same");
  });

  it("edits in the middle, prefix, and suffix", () => {
    expect(applySplice("abcdef", "abXYef")).toBe("abXYef"); // middle replace
    expect(applySplice("abcdef", "ZZcdef")).toBe("ZZcdef"); // prefix
    expect(applySplice("abcdef", "abcdZZ")).toBe("abcdZZ"); // suffix
    expect(applySplice("abcdef", "abef")).toBe("abef"); // middle delete
    expect(applySplice("abef", "abcdef")).toBe("abcdef"); // middle insert
  });
});

describe("updateTextContent", () => {
  it("splices into an existing collaborative-text string field", () => {
    let doc = A.from<{ content: string }>({ content: "version 1" });
    doc = A.change(doc, (d) => updateTextContent(d, ["content"], "version 2"));
    expect(doc.content).toBe("version 2");
  });

  it("converts a legacy ImmutableString field by assigning the new value", () => {
    // Old docs store text as RawString (not spliceable). updateTextContent must
    // assign, converting the field to a collaborative text string.
    let doc = A.from<{ content: unknown }>({
      content: new A.RawString("legacy old"),
    });
    expect(A.isImmutableString(doc.content)).toBe(true);

    doc = A.change(doc, (d) => updateTextContent(d, ["content"], "fresh new"));

    expect(typeof doc.content).toBe("string");
    expect(doc.content).toBe("fresh new");
    expect(A.isImmutableString(doc.content)).toBe(false);
  });
});

describe("readDocContent", () => {
  it("normalizes the content variants", () => {
    expect(readDocContent(null)).toBeNull();
    expect(readDocContent(undefined)).toBeNull();
    expect(readDocContent("hi")).toBe("hi");

    const bytes = new Uint8Array([1, 2, 3]);
    expect(readDocContent(bytes)).toBe(bytes);

    // Legacy ImmutableString → plain string.
    expect(readDocContent(new A.RawString("legacy"))).toBe("legacy");
  });
});
