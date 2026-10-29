// Keyhive sync with one subduction_keyhive server, over subduction's keyhive (SUK) frames.
//
// We initiate; a round is
//
//   us ── SyncRequest(found, pending) + our card ──► server
//   us ◄── SyncResponse(found ops, requested) ────── server
//   us ── SyncOps(requested) ───────────────────────► server   (if it asked for any)
//   confirmation from whichever side finishes last
//
// and we also answer what the server starts itself: a contact card request, or its own
// sync request after one.

import type { Subduction } from "@automerge/automerge-subduction";
import { ContactCard, Identifier, type Keyhive, SignedBytes, Signer } from "@keyhive/keyhive";
import { type Addressed, type Hash, type Message, decodeMessage, decodeSigned, encodeMessage, encodeSigned } from "./wire.js";

/** Runs keyhive calls one at a time: keyhive's wasm is not reentrant. */
export type Serial = <T>(f: () => Promise<T>) => Promise<T>;

export function serial(): Serial {
	let tail: Promise<unknown> = Promise.resolve();
	return f => {
		const run = tail.then(f);
		tail = run.catch(() => {});
		return run;
	};
}

export type SyncOptions = {
	kh: Keyhive;
	run: Serial;
	node: Subduction;
	/** The server's verifying key. */
	server: Uint8Array;
	/** Our card, sent with every request so the server never has to ask for it. */
	card: ContactCard;
	timeoutMs?: number;
};

/** Start answering the server; the result syncs until a round brings in nothing new. */
export async function keylineSync({ kh, run, node, server, card, timeoutMs = 30_000 }: SyncOptions) {
	const me = await run(async () => (await kh.individual()).id.toBytes());
	const serverPeer = (await node.getConnectedPeerIds()).find(p => equal(p.toBytes(), server));
	if (!serverPeer) throw new Error("the keyhive server is not connected");

	let round: { done(): void; fail(e: unknown): void } | undefined;
	let ingested = false;

	const send = (message: Message, withCard = false) =>
		run(async () => {
			const signed = (await kh.trySign(encodeMessage({ sender: me, target: server, message }))).toBytes();
			return encodeSigned({ signed, contactCard: withCard ? card.toBytes() : undefined });
		}).then(bytes => node.sendKeyhiveMessage(bytes, serverPeer));

	// the events both of us can reach, which are all the server may be sent
	const pair = () => run(() => eventsForPair(kh, me, server));

	const ingest = (events: Uint8Array[]) =>
		run(async () => {
			if (!events.length) return;
			const before = (await kh.stats()).totalOps;
			await kh.ingestEventsBytes(events);
			if ((await kh.stats()).totalOps !== before) ingested = true;
		});

	async function handle({ message }: Addressed) {
		switch (message.type) {
			case "SyncResponse": {
				await ingest(message.found);
				const ours = await pair();
				const ops = message.requested.flatMap(h => ours.get(hex(h)) ?? []);
				if (ops.length) {
					// the server confirms once it has them
					await send({ type: "SyncOps", ops, responderTotal: message.responderTotal, requesterTotal: message.requesterTotal });
					return;
				}
				await send({ type: "SyncConfirmation", confirmerTotal: message.requesterTotal });
				round?.done();
				return;
			}
			case "SyncConfirmation":
				round?.done();
				return;
			case "RequestContactCard":
				await send({ type: "MissingContactCard" }, true);
				return;
			case "SyncRequest": {
				const ours = await pair();
				const pending = await run(() => pendingHashes(kh));
				const theirs = new Set([...message.found, ...message.pending].map(hex));
				const skip = new Set([...ours.keys(), ...pending.map(hex)]);
				await send({
					type: "SyncResponse",
					found: [...ours].filter(([h]) => !theirs.has(h)).map(([, bytes]) => bytes),
					requested: message.found.filter(h => !skip.has(hex(h))),
					responderTotal: ours.size + pending.length,
					requesterTotal: message.found.length + message.pending.length,
				});
				return;
			}
			case "SyncOps":
				await ingest(message.ops);
				await send({ type: "SyncConfirmation", confirmerTotal: message.responderTotal });
				return;
			case "MissingContactCard":
			case "SyncCheck":
				// the card came with the message; our own round does the full sync
				return;
		}
	}

	// inbound frames are handled in order, one at a time
	let inbox = Promise.resolve();
	await node.registerFrameHandler({
		onMessage(payload, peer) {
			if (!equal(peer.toBytes(), server)) return;
			inbox = inbox.then(() => receive(kh, run, server, payload).then(m => m && handle(m))).catch(e => round?.fail(e));
		},
		onPeerDisconnect(peer) {
			if (equal(peer.toBytes(), server)) round?.fail(new Error("the keyhive server disconnected"));
		},
	});

	const once = async () => {
		const [ours, pending] = await Promise.all([pair(), run(() => pendingHashes(kh))]);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => finish(new Error("keyhive sync timed out")), timeoutMs);
			const finish = (e?: unknown) => {
				clearTimeout(timer);
				round = undefined;
				if (e) reject(e);
				else resolve();
			};
			round = { done: () => finish(), fail: e => finish(e ?? new Error("keyhive sync failed")) };
			send({ type: "SyncRequest", found: [...ours.keys()].map(unhex), pending }, true).catch(round.fail);
		});
	};

	return {
		// what a round brings in can make more events reachable, so go again until it doesn't
		async sync(maxRounds = 10) {
			for (let i = 0; i < maxRounds; i++) {
				ingested = false;
				await once();
				if (!ingested) return;
			}
		},
		close: () => node.registerFrameHandler(null),
	};
}

/**
 * Ask the server at `url` for its contact card (base64). The subduction handshake proves
 * the server's key, so the card is taken only if it is that key's.
 */
export async function fetchCard(url: string, timeoutMs = 15_000): Promise<string> {
	const { MemorySigner, MemoryStorage } = await import("@automerge/automerge-subduction");
	const { Docs } = await import("../../docs.js");
	// the server checks that keyhive messages are signed by the connection's own key
	const seed = crypto.getRandomValues(new Uint8Array(32));
	const signer = Signer.memorySignerFromBytes(seed);
	const docs = await Docs.open({ storage: new MemoryStorage(), signer: MemorySigner.fromBytes(seed), server: url });
	try {
		const peer = docs.peer;
		if (!peer) throw new Error(`could not connect to ${url}`);
		const server = peer.toBytes();
		const card = new Promise<string>((resolve, reject) => {
			setTimeout(() => reject(new Error(`${url} sent no keyhive contact card`)), timeoutMs).unref();
			void docs.node.registerFrameHandler({
				onMessage(payload) {
					try {
						const { contactCard, signed } = decodeSigned(payload);
						const bytes = SignedBytes.fromBytes(signed);
						if (!contactCard || !bytes.verify() || !equal(bytes.verifyingKey, server)) return;
						if (!equal(ContactCard.fromBytes(contactCard).id.toBytes(), server)) {
							reject(new Error(`${url} sent a contact card that isn't its own`));
							return;
						}
						resolve(Buffer.from(contactCard).toString("base64"));
					} catch (e) {
						reject(e);
					}
				},
				onPeerDisconnect: () => reject(new Error(`${url} disconnected`)),
			});
		});
		const message = encodeMessage({ sender: signer.verifyingKey, target: server, message: { type: "RequestContactCard" } });
		await docs.node.sendKeyhiveMessage(encodeSigned({ signed: (await signer.trySign(message)).toBytes() }), peer);
		return await card;
	} finally {
		await docs.close();
	}
}

// a verified message from the server, or nothing for one that isn't
async function receive(kh: Keyhive, run: Serial, server: Uint8Array, payload: Uint8Array): Promise<Addressed | undefined> {
	const { contactCard, signed } = decodeSigned(payload);
	const bytes = SignedBytes.fromBytes(signed);
	if (!bytes.verify() || !equal(bytes.verifyingKey, server)) return undefined;
	const message = decodeMessage(bytes.payload());
	if (!equal(message.sender, server)) return undefined;
	if (contactCard) {
		const card = ContactCard.fromBytes(contactCard);
		await run(async () => {
			if (!(await kh.hasIndividual(card.individualId))) await kh.receiveContactCard(card);
		});
	}
	return message;
}

/** The events `a` and `b` can both reach, by hash (hex). */
export async function eventsForPair(kh: Keyhive, a: Uint8Array, b: Uint8Array): Promise<Map<string, Uint8Array>> {
	const [ours, theirs] = [await eventsFor(kh, a), await eventsFor(kh, b)];
	return new Map([...ours].filter(([h]) => theirs.has(h)));
}

// what keyhive sends `id`: its membership, prekey and CGKA events, and its own prekey ops
async function eventsFor(kh: Keyhive, id: Uint8Array): Promise<Map<string, Uint8Array>> {
	const principal = await kh.getPrincipal(new Identifier(id));
	const out = new Map<string, Uint8Array>();
	for (const events of [await kh.eventsForAgent(principal), await principal.keyOps()]) {
		for (const [hash, bytes] of events as Map<Hash, Uint8Array>) out.set(hex(hash), bytes);
	}
	return out;
}

const pendingHashes = async (kh: Keyhive): Promise<Hash[]> => [...((await kh.pendingEventHashes()) as Set<Hash>)];

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
