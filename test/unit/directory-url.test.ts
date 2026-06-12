/**
 * URL normalization (src/utils/directory.ts getPlainUrl).
 *
 * CLAUDE.md's #1 documented pitfall: `repo.find(versionedUrl)` returns a view
 * pinned at the version heads, so every navigation/update path must strip
 * heads first. Stale-heads bugs caused the v1.1.x artifact resurrection family.
 * Previously untested.
 */

import * as A from "@automerge/automerge";
import * as fc from "fast-check";
import {
	encodeHeads,
	generateAutomergeUrl,
	parseAutomergeUrl,
	stringifyAutomergeUrl,
	AutomergeUrl,
} from "@automerge/automerge-repo";
import { getPlainUrl } from "../../src/utils/directory";

/** A versioned URL built from REAL Automerge heads (format-valid by construction). */
function versionedUrl(edits: number): { plain: AutomergeUrl; versioned: AutomergeUrl } {
	const plain = generateAutomergeUrl();
	const { documentId } = parseAutomergeUrl(plain);

	let doc = A.from<{ n: number }>({ n: 0 });
	for (let i = 0; i < edits; i++) {
		doc = A.change(doc, (d) => {
			d.n = i + 1;
		});
	}
	// URL heads are bs58check-encoded, not the raw hex from A.getHeads.
	const heads = encodeHeads(A.getHeads(doc));
	return { plain, versioned: stringifyAutomergeUrl({ documentId, heads }) };
}

describe("getPlainUrl", () => {
	it("property: plain URLs pass through unchanged", () => {
		fc.assert(
			fc.property(fc.constant(null), () => {
				const url = generateAutomergeUrl();
				return getPlainUrl(url) === url;
			}),
			{ numRuns: 50 }
		);
	});

	it("property: stripping heads recovers the plain URL, for any edit history", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 5 }), (edits) => {
				const { plain, versioned } = versionedUrl(edits);
				return versioned !== plain && getPlainUrl(versioned) === plain;
			}),
			{ numRuns: 25 } // each run builds a real doc; keep it modest
		);
	});

	it("property: idempotent — getPlainUrl(getPlainUrl(u)) === getPlainUrl(u)", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 3 }), (edits) => {
				const { versioned } = versionedUrl(edits);
				const once = getPlainUrl(versioned);
				return getPlainUrl(once) === once;
			}),
			{ numRuns: 25 }
		);
	});

	it("versioned URLs contain a fragment; plain ones do not", () => {
		const { plain, versioned } = versionedUrl(2);
		expect(versioned).toContain("#");
		expect(plain).not.toContain("#");
		expect(getPlainUrl(versioned)).not.toContain("#");
	});
});
