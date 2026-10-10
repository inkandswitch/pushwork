import bs58check from "bs58check";
import { SedimentreeId } from "@automerge/automerge-subduction";

// bs58check of 16 bytes (plain) or 32 bytes (keyhive)
export type DocumentId = string & { __docId: true };
export type AutomergeUrl = `automerge:${string}`;

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

export function newDocumentId(): DocumentId {
	const b = crypto.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	return bs58check.encode(b) as DocumentId;
}

export function toSedimentreeId(id: DocumentId): SedimentreeId {
	const bytes = new Uint8Array(32);
	bytes.set(bs58check.decode(id));
	return SedimentreeId.fromBytes(bytes);
}

export function isProtected(id: DocumentId): boolean {
	const b = bs58check.decode(id);
	return b.length === 32 && b.subarray(16).some(x => x !== 0);
}

export function parseAutomergeUrl(url: string): {
	documentId: DocumentId;
	heads?: string[];
} {
	const [base, heads, ...rest] = url.split("#");
	const match = /^automerge:([^/]+)$/.exec(base);
	const raw = match && bs58check.decodeUnsafe(match[1]);
	if (rest.length || !raw || (raw.length !== 16 && raw.length !== 32)) {
		throw new Error(`invalid automerge url: ${url}`);
	}
	const documentId = match[1] as DocumentId;
	if (heads === undefined) return { documentId };
	return {
		documentId,
		heads:
			heads === "" ? [] : heads.split("|").map(h => toHex(bs58check.decode(h))),
	};
}

export function stringifyAutomergeUrl(
	id: DocumentId,
	heads?: string[]
): AutomergeUrl {
	if (!heads) return `automerge:${id}`;
	return `automerge:${id}#${encodeHeads(heads).sort().join("|")}`;
}

export function isValidAutomergeUrl(s: unknown): s is AutomergeUrl {
	if (typeof s !== "string") return false;
	try {
		parseAutomergeUrl(s);
		return true;
	} catch {
		return false;
	}
}

export const stripHeads = (url: AutomergeUrl): AutomergeUrl =>
	url.split("#")[0] as AutomergeUrl;

export const encodeHeads = (hex: string[]): string[] =>
	hex.map(h => bs58check.encode(fromHex(h)));
