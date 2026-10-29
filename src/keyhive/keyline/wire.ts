// The keyhive sync messages subduction_keyhive's server speaks, as CBOR. The Rust types
// are the source of truth (subduction_keyhive/src/{message,signed_message,peer_id}.rs):
//
//   SignedMessage  { contactCard: bytes (empty: none), signed: bytes }
//   signed         SignedBytes frame whose payload is CBOR(Message)
//   Message        externally tagged, snake_case: { "SyncRequest": { sender_id, ... } }
//   KeyhivePeerId  { verifying_key: bytes(32), suffix: null }
//
// Subduction adds and strips the SUK frame around SignedMessage itself.

import { decode, encode } from "cbor-x";

export type Hash = Uint8Array;

/** A keyhive sync message, without the sender and target every message carries. */
export type Message =
	| { type: "SyncRequest"; found: Hash[]; pending: Hash[] }
	| { type: "SyncResponse"; requested: Hash[]; found: Uint8Array[]; responderTotal: number; requesterTotal: number }
	| { type: "SyncOps"; ops: Uint8Array[]; responderTotal: number; requesterTotal: number }
	| { type: "RequestContactCard" }
	| { type: "MissingContactCard" }
	| { type: "SyncCheck"; senderTotal: number; senderSyncpoint: number; senderDigest: Hash }
	| { type: "SyncConfirmation"; confirmerTotal: number };

/** A message with its sender and target, each a 32-byte verifying key. */
export type Addressed = { sender: Uint8Array; target: Uint8Array; message: Message };

export type SignedMessage = { contactCard?: Uint8Array; signed: Uint8Array };

export class WireError extends Error {
	constructor(message: string) {
		super(`keyhive wire: ${message}`);
		this.name = "WireError";
	}
}

export const encodeSigned = ({ contactCard, signed }: SignedMessage): Uint8Array =>
	encode({ contactCard: contactCard ?? new Uint8Array(), signed });

export function decodeSigned(bytes: Uint8Array): SignedMessage {
	const raw = decode(bytes) as Record<string, unknown>;
	const contactCard = asBytes(raw?.contactCard, "contactCard");
	return { contactCard: contactCard.length ? contactCard : undefined, signed: asBytes(raw?.signed, "signed") };
}

export function encodeMessage({ sender, target, message }: Addressed): Uint8Array {
	const ids = { sender_id: peerId(sender), target_id: peerId(target) };
	switch (message.type) {
		case "SyncRequest":
			return tagged(message.type, { ...ids, found: message.found, pending: message.pending });
		case "SyncResponse":
			return tagged(message.type, {
				...ids,
				requested: message.requested,
				found: message.found,
				sync_responder_total: message.responderTotal,
				sync_requester_total: message.requesterTotal,
			});
		case "SyncOps":
			return tagged(message.type, {
				...ids,
				ops: message.ops,
				sync_responder_total: message.responderTotal,
				sync_requester_total: message.requesterTotal,
			});
		case "RequestContactCard":
		case "MissingContactCard":
			return tagged(message.type, ids);
		case "SyncCheck":
			return tagged(message.type, {
				...ids,
				sender_total: message.senderTotal,
				sender_syncpoint: message.senderSyncpoint,
				sender_digest: message.senderDigest,
			});
		case "SyncConfirmation":
			return tagged(message.type, { ...ids, confirmer_total: message.confirmerTotal });
	}
}

export function decodeMessage(bytes: Uint8Array): Addressed {
	const raw = decode(bytes) as Record<string, Record<string, unknown>>;
	const variants = raw && typeof raw === "object" ? Object.keys(raw) : [];
	if (variants.length !== 1) throw new WireError(`expected one message variant, got ${variants.length}`);
	const [type] = variants;
	const v = raw[type];
	if (!v || typeof v !== "object") throw new WireError(`${type} is not a map`);
	const sender = verifyingKey(v.sender_id, "sender_id");
	const target = verifyingKey(v.target_id, "target_id");
	const at = (message: Message): Addressed => ({ sender, target, message });
	switch (type) {
		case "SyncRequest":
			return at({ type, found: byteList(v.found, "found"), pending: byteList(v.pending, "pending") });
		case "SyncResponse":
			return at({
				type,
				requested: byteList(v.requested, "requested"),
				found: byteList(v.found, "found"),
				responderTotal: total(v.sync_responder_total),
				requesterTotal: total(v.sync_requester_total),
			});
		case "SyncOps":
			return at({
				type,
				ops: byteList(v.ops, "ops"),
				responderTotal: total(v.sync_responder_total),
				requesterTotal: total(v.sync_requester_total),
			});
		case "RequestContactCard":
		case "MissingContactCard":
			return at({ type });
		case "SyncCheck":
			return at({
				type,
				senderTotal: total(v.sender_total),
				senderSyncpoint: total(v.sender_syncpoint),
				senderDigest: asBytes(v.sender_digest ?? new Uint8Array(32), "sender_digest"),
			});
		case "SyncConfirmation":
			return at({ type, confirmerTotal: total(v.confirmer_total) });
		default:
			throw new WireError(`unknown message variant ${type}`);
	}
}

const tagged = (variant: string, fields: Record<string, unknown>) => encode({ [variant]: fields });

// the server keys peers by verifying key alone, so a suffix is never sent
const peerId = (key: Uint8Array) => ({ verifying_key: key, suffix: null });

function verifyingKey(raw: unknown, field: string): Uint8Array {
	const key = asBytes((raw as { verifying_key?: unknown } | undefined)?.verifying_key, `${field}.verifying_key`);
	if (key.length !== 32) throw new WireError(`${field}.verifying_key is ${key.length} bytes, not 32`);
	return key;
}

function asBytes(raw: unknown, field: string): Uint8Array {
	if (raw instanceof Uint8Array) return raw;
	throw new WireError(`${field} is not a byte string`);
}

function byteList(raw: unknown, field: string): Uint8Array[] {
	if (!Array.isArray(raw)) throw new WireError(`${field} is not an array`);
	return raw.map((item, i) => asBytes(item, `${field}[${i}]`));
}

// totals are u64s; cbor-x hands back a bigint only past 2^53
const total = (raw: unknown) => Number(raw ?? 0);
