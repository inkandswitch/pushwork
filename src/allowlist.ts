import type { EphemeralPolicy, PeerId, Policy, SedimentreeId } from "@automerge/automerge-subduction";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const key = (peer: PeerId, id: SedimentreeId) => hex(peer.toBytes()) + "/" + hex(id.toBytes());

/**
 * The documents this run started syncing with each peer. The machine's store holds every
 * document, so a peer may only fetch or push the ones we asked it about.
 */
export class Allowlist {
	private allowed = new Set<string>();

	allow(peer: PeerId, id: SedimentreeId): void {
		this.allowed.add(key(peer, id));
	}

	has(peer: PeerId, id: SedimentreeId): boolean {
		return this.allowed.has(key(peer, id));
	}

	policy(): Policy {
		const check = async (peer: PeerId, id: SedimentreeId) => {
			if (!this.has(peer, id)) throw new Error("not synced with this peer");
		};
		return {
			authorizeConnect: async () => {},
			authorizeFetch: check,
			authorizePut: (requestor, _author, id) => check(requestor, id),
			filterAuthorizedFetch: async (peer, ids) => ids.filter(id => this.has(peer, id)),
		};
	}

	// pushwork doesn't use ephemeral messages
	ephemeralPolicy(): EphemeralPolicy {
		const deny = async () => {
			throw new Error("ephemeral messages are not accepted");
		};
		return {
			authorizeSubscribe: deny,
			authorizePublish: deny,
			filterAuthorizedSubscribers: async () => [],
		};
	}
}
