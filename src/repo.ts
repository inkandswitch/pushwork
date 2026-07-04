import {
	Repo,
	initSubduction,
	setLoggerFactory,
	type AutomergeUrl,
	type DocHandle,
	type NetworkAdapterInterface,
} from "@automerge/automerge-repo";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import debug from "debug";
import type { Backend } from "./config.js";
import { log } from "./log.js";

const dlog = log("repo");

// Where automerge-repo `error`-level logs go. Default: silent (routed to
// `debug`). The main CLI overrides it (setAmrepoErrorSink) to surface failures;
// workers keep the silent default so they never write to the parent's output.
type AmrepoErrorSink = (
	namespace: string,
	message: string,
	...args: unknown[]
) => void;
let amrepoErrorSink: AmrepoErrorSink = (namespace, message, ...args) =>
	debug(namespace)(message, ...args);

/** Route automerge-repo `error`-level logs somewhere visible (e.g. the CLI UI). */
export function setAmrepoErrorSink(sink: AmrepoErrorSink): void {
	amrepoErrorSink = sink;
}

// Route automerge-repo logging through `debug` (silent by default; opt in with
// `DEBUG=automerge-repo:subduction:*`), except `error` → the sink above.
// Installed in openRepo so it also covers the shard worker threads.
let amrepoLoggingInstalled = false;
function installAmrepoLogging(): void {
	if (amrepoLoggingInstalled) return;
	amrepoLoggingInstalled = true;
	setLoggerFactory((namespace) => {
		const trace = debug(namespace);
		const to = (message: string, ...args: unknown[]) => trace(message, ...args);
		return {
			debug: to,
			info: to,
			warn: to,
			error: (message: string, ...args: unknown[]) =>
				amrepoErrorSink(namespace, message, ...args),
		};
	});
}

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
	installAmrepoLogging();
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

// Above am-repo's own ~5s shutdown quiesce (so last-mile delivery completes),
// but well under the ~60s stall a stuck roundtrip or reconnect can cause.
const DEFAULT_SHUTDOWN_MS = 15000;

/**
 * Shut a repo down without a slow/dropped connection hanging the CLI: race
 * `repo.shutdown()` against a bounded deadline, then continue (process exit
 * closes any lingering socket). Teardown errors are ignored — the work is
 * already done. Override with `PUSHWORK_SHUTDOWN_MS` (`0` = unbounded).
 */
export async function safeShutdown(
	repo: Repo,
	{ maxMs }: { maxMs?: number } = {},
): Promise<void> {
	const envRaw = process.env.PUSHWORK_SHUTDOWN_MS;
	const env = envRaw == null ? Number.NaN : Number(envRaw);
	const deadline = maxMs ?? (Number.isFinite(env) ? env : DEFAULT_SHUTDOWN_MS);

	// Never rejects: teardown hiccups (transport or otherwise) go to debug only.
	const shutdown = (async () => {
		try {
			await repo.shutdown();
		} catch (err) {
			dlog(
				"safeShutdown: ignored %s during shutdown: %s",
				isTransportError(err) ? "transport error" : "error",
				errMessage(err),
			);
		}
	})();

	if (deadline <= 0) {
		await shutdown;
		return;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			dlog("safeShutdown: exceeded %dms; continuing (exit closes sockets)", deadline);
			resolve();
		}, deadline);
	});
	try {
		await Promise.race([shutdown, bound]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Whether an error is a network/transport blip (dropped WebSocket, reset/refused
 * socket, DNS hiccup, …) — expected on flaky links and during teardown, so
 * callers suppress it rather than fail the command.
 */
export function isTransportError(err: unknown): boolean {
	const msg = errMessage(err).toLowerCase();
	return (
		msg.includes("websocket") ||
		msg.includes("socket hang up") ||
		msg.includes("econnreset") ||
		msg.includes("econnrefused") ||
		msg.includes("econnaborted") ||
		msg.includes("epipe") ||
		msg.includes("etimedout") ||
		msg.includes("enotfound") ||
		msg.includes("eai_again") ||
		msg.includes("unexpected server response") ||
		msg.includes("ws error")
	);
}

const errMessage = (err: unknown): string =>
	err instanceof Error ? `${err.name}: ${err.message}` : String(err);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Where a document stands relative to the Subduction sync server. Returned by
 * {@link waitForServerSync}; the CLI renders the two head sets so you can see at
 * a glance that your repo and the server agree.
 */
export type SyncSnapshot = {
	/** The document this snapshot describes (the root folder doc, for `sync`). */
	url: AutomergeUrl;
	/**
	 * True only when confirmed both ways: we hold every commit the server
	 * advertised AND it has advertised our frontier back (push-confirmed). Never
	 * true on a bare pull-settle, so the CLI won't print SYNCED before our change
	 * has demonstrably landed.
	 */
	synced: boolean;
	/**
	 * Connected and pull-complete, but our push wasn't confirmed before the
	 * deadline — shown as PENDING. Usually transient; can be a false-negative if
	 * the server compacted our change into a differently-id'd fragment (see
	 * `.ignore/FIXME.md`).
	 */
	pending: boolean;
	/** Whether the repo currently has a live Subduction connection to a server. */
	connected: boolean;
	/** The sync server's peer id (its verifying key), once the handshake is done. */
	serverPeerId?: string;
	/** Our current Automerge heads for the doc. */
	localHeads: string[];
	/** The heads the server last advertised for the doc (Subduction sedimentree heads). */
	serverHeads: string[];
	/**
	 * How long the Subduction connection took this run (ms, from repo open to the
	 * `subduction-connection` handshake). `0` if already connected; undefined on
	 * legacy or if we never connected.
	 */
	connectMs?: number;
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

export type Connection = {
	connected: boolean;
	/** ms from this call until the connection was established (0 if already up). */
	connectMs: number;
	serverPeerId?: string;
};

/**
 * Resolve once the repo's Subduction connection is established, reporting how
 * long the handshake took (via the `subduction-connection` event). Resolves
 * connected=false after `maxMs` instead of hanging; returns immediately on
 * legacy. Elapsed is measured from the call, so starting it right after
 * {@link openRepo} lets local work overlap the connect.
 */
export async function waitForConnection(
	repo: Repo,
	backend: Backend,
	{ maxMs = 15000 }: { maxMs?: number } = {},
): Promise<Connection> {
	const start = Date.now();
	if (backend !== "subduction") return { connected: false, connectMs: 0 };
	if (repo.isSubductionConnected()) {
		return { connected: true, connectMs: 0, serverPeerId: await connectedServerPeer(repo) };
	}

	const connected = await new Promise<boolean>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onConn = (p: { connected: boolean }) => {
			if (!p.connected) return;
			if (timer) clearTimeout(timer);
			repo.off("subduction-connection", onConn);
			resolve(true);
		};
		repo.on("subduction-connection", onConn);
		timer = setTimeout(() => {
			repo.off("subduction-connection", onConn);
			resolve(repo.isSubductionConnected());
		}, maxMs);
	});

	return {
		connected,
		connectMs: Date.now() - start,
		serverPeerId: connected ? await connectedServerPeer(repo) : undefined,
	};
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

// Docs already nudged for a resync this run, keyed by repo, so the several
// waitForServerSync calls in one command don't re-fire `resyncSubduction` on the
// same doc. One nudge per doc per run; am-repo's heal loop handles the rest.
const resyncedDocs = new WeakMap<Repo, Set<string>>();

// Returns true the first time a given doc is nudged for this repo, false after.
// Exported for unit testing the dedup; not part of the public API.
export function claimResync(repo: Repo, documentId: string): boolean {
	let seen = resyncedDocs.get(repo);
	if (!seen) {
		seen = new Set<string>();
		resyncedDocs.set(repo, seen);
	}
	if (seen.has(documentId)) return false;
	seen.add(documentId);
	return true;
}

/**
 * The two-directional sync verdict: `synced` when settled, pull-complete, and the
 * server has advertised our frontier back (push-confirmed); `pending` when
 * settled and pull-complete but not yet push-confirmed. Both false while behind
 * or unsettled.
 */
export function syncVerdict(args: {
	localQuiet: boolean;
	pullComplete: boolean;
	frontier: readonly string[];
	advertised: readonly string[];
}): { synced: boolean; pending: boolean } {
	const advertised = new Set(args.advertised);
	const pushConfirmed =
		args.frontier.length > 0 && args.frontier.every((h) => advertised.has(h));
	const settledAndCaughtUp = args.localQuiet && args.pullComplete;
	return {
		synced: settledAndCaughtUp && pushConfirmed,
		pending: settledAndCaughtUp && !pushConfirmed,
	};
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
			pending: false,
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
			let pending = false;
			if (serverPeerId) {
				const info = handle.getSyncInfo(serverPeerId as never);
				if (info && info.lastHeads.length > 0) {
					({ synced, pending } = syncVerdict({
						localQuiet,
						pullComplete: handle.containsHeads(info.lastHeads),
						frontier: headsOf(),
						advertised: info.lastHeads,
					}));
					// For display, trim the sedimentree heads down to our frontier
					// tip(s) plus anything we genuinely lack, so the reported
					// server heads line up with localHeads (and match once synced).
					serverHeads = trimSeenHeads(handle, info.lastHeads);
				}
			}

			if (synced || now - start >= maxMs) {
				dlog(
					"waitForServerSync %s url=%s elapsed=%dms",
					synced ? "synced" : pending ? "pending" : "timed out",
					handle.url,
					now - start,
				);
				return {
					url: handle.url,
					synced,
					pending: synced ? false : pending,
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
				resynced = true; // don't reconsider within this call regardless
				if (claimResync(repo, documentId)) {
					dlog("waitForServerSync nudging resync url=%s", handle.url);
					try {
						repo.resyncSubduction(documentId);
					} catch {
						// no Subduction source / doc not attached
					}
				} else {
					dlog("waitForServerSync resync already nudged this run url=%s", handle.url);
				}
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
