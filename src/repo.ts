import {
	Repo,
	initSubduction,
	type AutomergeUrl,
	type DocHandle,
	type NetworkAdapterInterface,
} from "@automerge/automerge-repo";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import type { Backend } from "./config.js";
import { log } from "./log.js";

const dlog = log("repo");

const DEFAULT_LEGACY = "wss://sync3.automerge.org";
const DEFAULT_SUBDUCTION = "wss://subduction.sync.inkandswitch.com";

export const legacyUrl = () =>
	process.env.PUSHWORK_LEGACY_SERVER || DEFAULT_LEGACY;
export const subductionUrl = () =>
	process.env.PUSHWORK_SUBDUCTION_SERVER || DEFAULT_SUBDUCTION;

function withFlushingShutdown(repo: Repo): Repo {
	const shutdown = repo.shutdown.bind(repo);
	repo.shutdown = async () => {
		try {
			await repo.flush();
		} finally {
			await shutdown();
		}
	};
	return repo;
}

export async function openRepo(
	backend: Backend,
	storageDir: string,
	opts: { offline?: boolean } = {},
): Promise<Repo> {
	dlog("openRepo backend=%s storage=%s offline=%s", backend, storageDir, !!opts.offline);
	await initSubduction();
	const storage = new NodeFSStorageAdapter(storageDir);
	if (opts.offline) {
		return withFlushingShutdown(new Repo({ storage, network: [] }));
	}
	if (backend === "legacy") {
		const endpoint = legacyUrl();
		dlog("legacy ws endpoint=%s", endpoint);
		const adapter = new WebSocketClientAdapter(
			endpoint,
		) as unknown as NetworkAdapterInterface;
		return withFlushingShutdown(new Repo({ storage, network: [adapter] }));
	}
	const endpoint = subductionUrl();
	dlog("subduction ws endpoint=%s", endpoint);
	return withFlushingShutdown(
		new Repo({
			storage,
			network: [],
			subductionWebsocketEndpoints: [endpoint],
		}),
	);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Where a document stands relative to the Subduction sync server. Returned by
 * {@link waitForServerSync}; the CLI renders the two head sets so you can see at
 * a glance that your repo and the server agree.
 */
export type SyncSnapshot = {
	/** The document this snapshot describes (the root folder doc, for `sync`). */
	url: AutomergeUrl;
	/** True once we hold every commit the sync server last advertised for the doc. */
	synced: boolean;
	/** Whether the repo currently has a live Subduction connection to a server. */
	connected: boolean;
	/** The sync server's peer id (its verifying key), once the handshake is done. */
	serverPeerId?: string;
	/** Our current Automerge heads for the doc. */
	localHeads: string[];
	/** The heads the server last advertised for the doc (Subduction sedimentree heads). */
	serverHeads: string[];
};

// The connected sync-server peer id (its verifying key), or undefined while the
// handshake is still in flight / there is no Subduction connection at all.
async function connectedServerPeer(repo: Repo): Promise<string | undefined> {
	if (!repo.isSubductionConnected()) return undefined;
	try {
		return (await repo.connectedSubductionPeerIds())[0];
	} catch {
		return undefined; // no Subduction source
	}
}

// Trim a peer's advertised heads for *display*. The sync server advertises
// Subduction sedimentree heads (loose-commit + fragment-boundary commit ids),
// most of which are interior commits we already hold — so the raw list is long
// and never resembles our Automerge frontier. Drop everything we already hold
// that isn't a current frontier tip, keeping our tip(s) plus any head we
// genuinely lack. The result lines up with `handle.heads()` and collapses to it
// once synced. Display only — the synced verdict still uses the full set.
function trimSeenHeads<T>(
	handle: DocHandle<T>,
	heads: readonly string[],
): string[] {
	let frontier: Set<string>;
	try {
		frontier = new Set<string>([...handle.heads()]);
	} catch {
		return [...heads];
	}
	return heads.filter((h) => {
		if (frontier.has(h)) return true; // our latest shared tip — keep
		try {
			return !handle.containsHeads([h] as never); // keep only what we lack
		} catch {
			return true; // can't decide → keep
		}
	});
}

// Sleep up to `ms`, but resolve early if `register`'s wake callback fires.
function sleepOrWake(
	ms: number,
	register: (wake: () => void) => void,
): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		register(() => {
			clearTimeout(t);
			resolve();
		});
	});
}

/**
 * Wait until `handle` is in sync with the Subduction sync server, judging
 * "synced" against the *server's* advertised heads rather than a local-settle
 * heuristic.
 *
 * The server advertises Subduction sedimentree heads (loose-commit and
 * fragment-boundary commit ids), which are NOT the Automerge frontier — so we
 * never compare them to `handle.heads()` for equality. Instead we ask whether we
 * already hold every commit the server advertises (`DocHandle.containsHeads`): if
 * we do, there is nothing left to pull, so we are caught up. This is
 * pull-completeness only — per Automerge's own note a peer can hold our latest
 * change inside a compacted fragment, so head comparison can't confirm the push
 * direction; we additionally gate on a brief local-heads settle so our own edit
 * has flushed before we trust the result.
 *
 * On the legacy backend there is no Subduction peer to hear from, so this falls
 * back to {@link waitForSync} and reports connected=false with empty serverHeads.
 */
export async function waitForServerSync<T>(
	repo: Repo,
	handle: DocHandle<T>,
	backend: Backend,
	{
		idleMs = 1500,
		maxMs = 15000,
		pollMs = 200,
		resyncAfterMs = 6000,
	}: { idleMs?: number; maxMs?: number; pollMs?: number; resyncAfterMs?: number } = {},
): Promise<SyncSnapshot> {
	const headsOf = () => [...(handle.heads() ?? [])] as string[];

	// Legacy backend never speaks Subduction: there are no server heads to
	// compare against, so settle locally and report what little we can.
	if (backend !== "subduction") {
		await waitForSync(handle, { idleMs, maxMs });
		return {
			url: handle.url,
			synced: true,
			connected: false,
			localHeads: headsOf(),
			serverHeads: [],
		};
	}

	const documentId = handle.documentId;
	dlog("waitForServerSync url=%s idleMs=%d maxMs=%d", handle.url, idleMs, maxMs);

	// Wake the poll loop the instant the server advertises new heads for this doc
	// (otherwise we just notice on the next poll tick).
	let wake: (() => void) | null = null;
	const onRemoteHeads = (p: { documentId: string }) => {
		if (p.documentId === documentId) wake?.();
	};
	repo.on("subduction-remote-heads", onRemoteHeads);

	const start = Date.now();
	let lastHeads = JSON.stringify(handle.heads());
	let lastHeadsChange = start;
	let resynced = false;

	try {
		for (;;) {
			const now = Date.now();
			const cur = JSON.stringify(handle.heads());
			if (cur !== lastHeads) {
				lastHeads = cur;
				lastHeadsChange = now;
			}
			const localQuiet = now - lastHeadsChange >= idleMs;

			const serverPeerId = await connectedServerPeer(repo);
			let serverHeads: string[] = [];
			let synced = false;
			if (serverPeerId) {
				const info = handle.getSyncInfo(serverPeerId as never);
				if (info && info.lastHeads.length > 0) {
					// The synced verdict uses the FULL advertised set: do we
					// already hold every commit the server has?
					synced = localQuiet && handle.containsHeads(info.lastHeads);
					// For display, trim the sedimentree heads down to our frontier
					// tip(s) plus anything we genuinely lack, so the reported
					// server heads line up with localHeads (and match once synced).
					serverHeads = trimSeenHeads(handle, info.lastHeads);
				}
			}

			if (synced || now - start >= maxMs) {
				dlog(
					"waitForServerSync %s url=%s elapsed=%dms",
					synced ? "synced" : "timed out",
					handle.url,
					now - start,
				);
				return {
					url: handle.url,
					synced,
					connected: repo.isSubductionConnected(),
					serverPeerId,
					localHeads: headsOf(),
					serverHeads,
				};
			}

			// Behind for a while and the scheduler isn't catching us up — re-arm a
			// single fresh sync round (the technique's stuck-doc nudge, without the
			// full per-doc exponential backoff a long-lived client would keep).
			if (!resynced && serverPeerId && now - start >= resyncAfterMs) {
				dlog("waitForServerSync nudging resync url=%s", handle.url);
				try {
					repo.resyncSubduction(documentId);
				} catch {
					// no Subduction source / doc not attached
				}
				resynced = true;
			}

			await sleepOrWake(pollMs, (fn) => {
				wake = fn;
			});
			wake = null;
		}
	} finally {
		repo.off("subduction-remote-heads", onRemoteHeads);
	}
}

export async function waitForSync<T>(
	handle: DocHandle<T>,
	{ minMs = 0, idleMs = 1500, maxMs = 15000, pollMs = 200 } = {},
): Promise<void> {
	dlog("waitForSync url=%s minMs=%d idleMs=%d maxMs=%d", handle.url, minMs, idleMs, maxMs);
	const headsKey = () => JSON.stringify(handle.heads());
	let last = headsKey();
	let lastChange = Date.now();
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		await sleep(pollMs);
		const next = headsKey();
		if (next !== last) {
			last = next;
			lastChange = Date.now();
		} else if (
			Date.now() - lastChange >= idleMs &&
			Date.now() - start >= minMs
		) {
			dlog("waitForSync settled url=%s elapsed=%dms", handle.url, Date.now() - start);
			return;
		}
	}
	dlog("waitForSync timed out url=%s after %dms", handle.url, maxMs);
}
