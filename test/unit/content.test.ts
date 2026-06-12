/**
 * Content hashing & equality (src/utils/content.ts) and its duplicate
 * (calculateContentHash in src/utils/fs.ts).
 *
 * `contentHash` is load-bearing for artifact change detection: a wrong or
 * inconsistent hash creates phantom local edits that replace artifact docs
 * wholesale and corrupt shared directory documents (the 2026-06-12
 * resurrection bug). Previously untested. The oracle property ties the two
 * functions together: equality and hash-equality must agree (for same-typed
 * inputs; SHA-256 collisions are unreachable for generated inputs).
 */

import * as fc from "fast-check";
import { contentHash, isContentEqual } from "../../src/utils/content";
import { calculateContentHash } from "../../src/utils/fs";

/** string | Uint8Array generator, biased toward small inputs. */
const contentArb = fc.oneof(
	fc.string({ maxLength: 256 }),
	fc.uint8Array({ maxLength: 256 })
);

describe("contentHash / isContentEqual", () => {
	it("property (oracle): same-typed contents are equal iff their hashes are equal", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.tuple(fc.string({ maxLength: 256 }), fc.string({ maxLength: 256 })),
					fc.tuple(fc.uint8Array({ maxLength: 256 }), fc.uint8Array({ maxLength: 256 }))
				),
				([a, b]) => {
					return isContentEqual(a, b) === (contentHash(a) === contentHash(b));
				}
			),
			{ numRuns: 500 }
		);
	});

	it("property: hash is stable across calls", () => {
		fc.assert(
			fc.property(contentArb, (c) => contentHash(c) === contentHash(c)),
			{ numRuns: 200 }
		);
	});

	it("property: fs.calculateContentHash agrees with content.contentHash (duplicate impls)", async () => {
		await fc.assert(
			fc.asyncProperty(contentArb, async (c) => {
				return (await calculateContentHash(c)) === contentHash(c);
			}),
			{ numRuns: 200 }
		);
	});

	it("cross-type semantics: same bytes as string vs Uint8Array hash alike but are NOT isContentEqual", () => {
		// Intentional: equality is type-strict (a text/binary reclassification is
		// a change), while the hash is byte-based (so a pure reclassification
		// with identical bytes does not look like a phantom artifact edit).
		const s = "hello world";
		const bytes = new Uint8Array(Buffer.from(s, "utf8"));
		expect(contentHash(s)).toBe(contentHash(bytes));
		expect(isContentEqual(s, bytes)).toBe(false);
	});

	it("null handling: null equals only itself", () => {
		expect(isContentEqual(null, null)).toBe(true);
		expect(isContentEqual(null, "")).toBe(false);
		expect(isContentEqual("", null)).toBe(false);
		expect(isContentEqual(null, new Uint8Array(0))).toBe(false);
	});

	it("empty string and empty bytes are distinct contents with identical hashes", () => {
		expect(contentHash("")).toBe(contentHash(new Uint8Array(0)));
		expect(isContentEqual("", new Uint8Array(0))).toBe(false);
	});
});
