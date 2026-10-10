import { describe, it, expect } from "vitest";
import bs58check from "bs58check";
import {
	type DocumentId,
	encodeHeads,
	isProtected,
	isValidAutomergeUrl,
	newDocumentId,
	parseAutomergeUrl,
	stringifyAutomergeUrl,
	stripHeads,
	toSedimentreeId,
} from "../../src/url.js";

// computed with automerge-repo 2.6.0-subduction.48's stringifyAutomergeUrl / encodeHeads
const bytes16 = Uint8Array.from({ length: 16 }, (_, i) => i * 7 + 1);
const bytes32 = Uint8Array.from({ length: 32 }, (_, i) => 255 - i * 3);
const id16 = "qLoujReChD4mrphFKSHcteTf7m" as DocumentId;
const id32 = "2wjsjZHLNdPMvRrFhbgBtdr73KSt9KbhjvuEH49M26S3pbRsfp" as DocumentId;
const h1 = "aa".repeat(32);
const h2 = "01".repeat(32);
const enc1 = "2JAT9y2EcnV6DPUGikLJYjWwk5UmUEFXRiQVmTbfSLbL4A4CMp";
const enc2 = "SeLqn3UAUoRymWmwW7axrzJK7JfNaBR2cHCryA6cFsgFkHEF";

describe("url", () => {
	it("matches automerge-repo encodings", () => {
		expect(bs58check.encode(bytes16)).toBe(id16);
		expect(bs58check.encode(bytes32)).toBe(id32);
		expect(encodeHeads([h1, h2])).toEqual([enc1, enc2]);
		expect(stringifyAutomergeUrl(id16, [h2, h1])).toBe(
			`automerge:${id16}#${enc1}|${enc2}`
		);
	});

	it("round trips 16 and 32 byte ids with and without heads", () => {
		for (const id of [id16, id32, newDocumentId()]) {
			expect(parseAutomergeUrl(stringifyAutomergeUrl(id))).toEqual({ documentId: id });
			const pinned = stringifyAutomergeUrl(id, [h1, h2]);
			const parsed = parseAutomergeUrl(pinned);
			expect(parsed.documentId).toBe(id);
			expect(parsed.heads?.sort()).toEqual([h1, h2].sort());
			expect(stripHeads(pinned)).toBe(`automerge:${id}`);
		}
		expect(parseAutomergeUrl(`automerge:${id16}#`).heads).toEqual([]);
	});

	it("rejects malformed urls", () => {
		for (const s of [
			"automerge:",
			`automerge:${id16}x`,
			`automerge:${id16}/path`,
			`automerge:${id16}#${enc1}#${enc2}`,
			`automerge:${id16}#nope`,
			`xautomerge:${id16}`,
			`automerge:${bs58check.encode(new Uint8Array(8))}`,
			42,
		]) {
			expect(isValidAutomergeUrl(s)).toBe(false);
		}
		expect(isValidAutomergeUrl(`automerge:${id32}#${enc1}`)).toBe(true);
	});

	it("makes uuid v4 ids", () => {
		const b = bs58check.decode(newDocumentId());
		expect(b.length).toBe(16);
		expect(b[6] >> 4).toBe(4);
		expect(b[8] >> 6).toBe(2);
		expect(newDocumentId()).not.toBe(newDocumentId());
	});

	it("zero-pads 16 byte ids to sedimentree ids", () => {
		const padded = new Uint8Array(32);
		padded.set(bytes16);
		expect(toSedimentreeId(id16).toBytes()).toEqual(padded);
		expect(toSedimentreeId(id32).toBytes()).toEqual(bytes32);
	});

	it("only treats 32 byte ids with a nonzero tail as protected", () => {
		const zeroTail = new Uint8Array(32);
		zeroTail.set(bytes16);
		expect(isProtected(id16)).toBe(false);
		expect(isProtected(bs58check.encode(zeroTail) as DocumentId)).toBe(false);
		expect(isProtected(id32)).toBe(true);
	});
});
