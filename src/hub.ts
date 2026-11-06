import { Subduction, setSubductionLogLevel, type PeerId, type Signer } from "@automerge/automerge-subduction";
import { Allowlist } from "./allowlist";
import { connect, type Connection } from "./docs";
import type { FsStorage } from "./storage";

const hex = (peer: PeerId) => Buffer.from(peer.toBytes()).toString("hex");

/**
 * One node on the machine's store, and a connection per server, for every Docs a long-lived
 * process opens. A node keeps the documents it has touched in memory and never rereads
 * storage, so a second node writing to the same store leaves this one sending stale state:
 * every write goes through this node.
 */
export class Hub {
	private peers = new Map<string, PeerId>();
	private dials = new Map<string, Promise<Connection>>();

	private constructor(
		readonly node: Subduction,
		readonly storage: FsStorage,
		readonly allowlist: Allowlist,
		private signer: Signer,
	) {}

	static open(storage: FsStorage, signer: Signer): Hub {
		if (!/subduction/.test(process.env.DEBUG ?? "")) setSubductionLogLevel("error");
		const allowlist = new Allowlist();
		const node = new Subduction({
			signer,
			storage,
			policy: allowlist.policy(),
			ephemeralPolicy: allowlist.ephemeralPolicy(),
		});
		return new Hub(node, storage, allowlist, signer);
	}

	/** The server's peer, dialling only when the node has no connection to it; callers at once share one dial. */
	async connect(server: string): Promise<Connection> {
		const peer = this.peers.get(server);
		if (peer) {
			const connected = (await this.node.getConnectedPeerIds()).map(hex);
			if (connected.includes(hex(peer))) return { peer, connectMs: 0 };
			// the server dropped it
			if (this.peers.get(server) === peer) this.peers.delete(server);
		}
		let dial = this.dials.get(server);
		if (!dial) {
			dial = connect(this.node, this.signer, server)
				.then(c => {
					if (c.peer) this.peers.set(server, c.peer);
					return c;
				})
				.finally(() => this.dials.delete(server));
			this.dials.set(server, dial);
		}
		return dial;
	}

	/** The servers the node is connected to now. */
	async servers(): Promise<{ server: string; peer: string }[]> {
		const connected = new Set((await this.node.getConnectedPeerIds()).map(hex));
		return [...this.peers]
			.map(([server, peer]) => ({ server, peer: hex(peer) }))
			.filter(({ peer }) => connected.has(peer));
	}

	async close(): Promise<void> {
		await this.node.disconnectAll();
		this.node.free();
	}
}

let current: Hub | undefined;
let daemon = false;

/** Mark this process as the daemon, which opens the machine's store through its hub. */
export function markDaemon(): void {
	daemon = true;
}

export function isDaemon(): boolean {
	return daemon;
}

/** The hub commands in this process open their docs through, if any. */
export function setHub(hub: Hub | undefined): void {
	current = hub;
}

export function currentHub(): Hub | undefined {
	return current;
}
