/**
 * Sørensen–Dice string similarity (src/utils/string-similarity.ts).
 *
 * This is the scoring function under MoveDetector: a wrong score silently
 * turns renames into delete+create (losing CRDT history) or pairs unrelated
 * files. Properties over arbitrary strings, plus
 * directed examples for the documented edge rules.
 */

import * as fc from "fast-check";
import { stringSimilarity } from "../../src/utils/string-similarity";

describe("stringSimilarity", () => {
	it("property: identical strings score exactly 1", () => {
		fc.assert(
			fc.property(fc.string(), (s) => stringSimilarity(s, s) === 1),
			{ numRuns: 200 }
		);
	});

	it("property: score is always within [0, 1]", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), (a, b) => {
				const s = stringSimilarity(a, b);
				return s >= 0 && s <= 1;
			}),
			{ numRuns: 500 }
		);
	});

	it("property: symmetric — sim(a, b) === sim(b, a)", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), (a, b) => {
				return stringSimilarity(a, b) === stringSimilarity(b, a);
			}),
			{ numRuns: 500 }
		);
	});

	it("property: case-insensitive for bigram-sized inputs — sim(a, b) === sim(upper(a), b)", () => {
		// Restricted to length ≥ 2: below the bigram window the identity
		// fast-path (which runs BEFORE lowercasing) makes sim("A","A")=1
		// while sim("a","A")=0 — see the directed test below.
		const s = fc.string({ minLength: 2 });
		fc.assert(
			fc.property(s, s, (a, b) => {
				return (
					stringSimilarity(a, b) === stringSimilarity(a.toUpperCase(), b)
				);
			}),
			{ numRuns: 300 }
		);
	});

	it("boundary quirk: sub-bigram strings differing only in case score 0", () => {
		// Found by fast-check: the str1===str2 fast-path precedes the
		// lowercasing, so exact equality scores 1 but case-insensitive
		// equality at length < 2 falls through to the too-short rule (0).
		// Harmless for move detection (file contents are never 1 char),
		// documented here so a future "fix" is a conscious choice.
		expect(stringSimilarity("a", "A")).toBe(0);
		expect(stringSimilarity("A", "A")).toBe(1);
	});

	it("strings shorter than the bigram window score 0 unless identical", () => {
		expect(stringSimilarity("a", "b")).toBe(0);
		expect(stringSimilarity("a", "ab")).toBe(0);
		expect(stringSimilarity("", "anything")).toBe(0);
		// ...but the identity fast-path still wins for short strings.
		expect(stringSimilarity("a", "a")).toBe(1);
		expect(stringSimilarity("", "")).toBe(1);
	});

	it("disjoint bigram sets score 0", () => {
		expect(stringSimilarity("aaaa", "bbbb")).toBe(0);
	});

	it("near-identical content scores above the default move threshold (0.7)", () => {
		// Mirrors the MoveDetector scenario: one-character edit in a sentence.
		const v1 = "export const greeting = 'hello world'; // v1";
		const v2 = "export const greeting = 'hello world'; // v2";
		expect(stringSimilarity(v1, v2)).toBeGreaterThan(0.7);
	});
});
