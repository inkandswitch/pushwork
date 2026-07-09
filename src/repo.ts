import {
	parseAutomergeUrl,
	Repo,
	WorkerWebSocketEndpoint,
	initSubduction,
	setLoggerFactory,
	setSubductionLogLevel,
	type AutomergeUrl,
	type DocHandle,
	type NetworkAdapterInterface,
} from "@automerge/automerge-repo";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { LMDBStorageAdapter } from "@automerge/automerge-repo-storage-lmdb";
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
// Installed in openRepo before any Repo construction.
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

// The Rust (Wasm) side logs through its own tracing writer straight to the
// console — setLoggerFactory doesn't route it. SubductionSource's constructor
// pins the filter to "warn", which lets benign close-path warnings (e.g.
// "connection closed, removing conn" from the worker transport's teardown)
// leak into CLI output. Drop it to "error" unless the user asked for
// subduction debugging; must run AFTER `new Repo()` (the constructor re-pins).
// `setSubductionLogLevel` is re-exported by automerge-repo, so this reaches
// the same Wasm instance the Repo uses.
//
// Runs on ALL backends deliberately: `new Repo()` constructs a
// SubductionSource unconditionally (offline and legacy included), and its
// constructor pins the global Rust filter to "warn" every time — the storage
// bridge and shutdown quiesce can warn even with no connection. The filter is
// a per-Wasm-instance singleton, so backend-gating would isolate nothing.
function quietSubductionRustLogs(): void {
	if (/subduction/i.test(process.env.DEBUG ?? "")) return;
	try {
		setSubductionLogLevel("error");
	} catch (err) {
		dlog("quietSubductionRustLogs failed: %s", errMessage(err));
	}
}

export async function openRepo(
	backend: Backend,
	storageDir: string,
	opts: { offline?: boolean } = {},
): Promise<Repo> {
	dlog("openRepo backend=%s storage=%s offline=%s", backend, storageDir, !!opts.offline);
	installAmrepoLogging();
	await initSubduction();
	// LMDB single-file database next to (not inside) the legacy nodefs chunk
	// tree: `<storage>.lmdb`. One env, a handful of fds, transactional
	// saveBatch. Repos created before the LMDB switch are carried over by the
	// 4 → 5 config migration (`pushwork migrate`, which readConfig's version
	// check directs users to).
	const storage = new LMDBStorageAdapter(`${storageDir}.lmdb`);
	const finish = (repo: Repo): Repo => {
		quietSubductionRustLogs();
		return repo;
	};
	if (opts.offline) {
		return finish(new Repo({ storage, network: [] }));
	}
	if (backend === "legacy") {
		const endpoint = legacyUrl();
		dlog("legacy ws endpoint=%s", endpoint);
		const adapter = new WebSocketClientAdapter(
			endpoint,
		) as unknown as NetworkAdapterInterface;
		return finish(new Repo({ storage, network: [adapter] }));
	}
	const endpoint = subductionUrl();
	if (process.env.PUSHWORK_WS_INLINE === "1") {
		dlog("subduction ws endpoint=%s (in-thread)", endpoint);
		return finish(
			new Repo({
				storage,
				network: [],
				subductionWebsocketEndpoints: [endpoint],
			}),
		);
	}
	// Socket + frame relay live in a worker_threads thread (auto-spawned by
	// upstream since subduction.41; torn down by repo.shutdown() via the
	// endpoint's teardown hook), so a busy main thread never stalls reads or
	// keepalives.
	dlog("subduction ws endpoint=%s (worker-hosted)", endpoint);
	return finish(
		new Repo({
			storage,
			network: [],
			subductionWebsocketEndpoints: [new WorkerWebSocketEndpoint(endpoint)],
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

/**
 * Whether an error is the upstream dispatch-after-shutdown race hitting a
 * closed storage adapter: an inbound subduction message can still be
 * dispatched after `Repo.shutdown()` has closed the LMDB env, and the read
 * throws "Can not read from a closed database". Harmless — the repo has
 * already flushed — but it surfaces as an unhandled rejection. Suppressed
 * like transport blips until upstream drains dispatch before closing
 * storage (reported; see .ignore/TODO.md).
 *
 * Deliberately narrow: the CLI feeds this to process-level handlers, so a
 * bare "already closed" (sockets, streams, …) must NOT match — only
 * database/environment-shaped messages (LMDB: "Can not read from a closed
 * database", "The environment is already closed").
 */
export function isClosedStorageError(err: unknown): boolean {
	const msg = errMessage(err).toLowerCase();
	return (
		msg.includes("closed database") ||
		(msg.includes("already closed") &&
			(msg.includes("database") ||
				msg.includes("environment") ||
				msg.includes("lmdb")))
	);
}

const errMessage = (err: unknown): string =>
	err instanceof Error ? `${err.name}: ${err.message}` : String(err);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `repo.find` with a deadline and one retry — the only unbounded await in a
 * pushwork command is a doc fetch, and a transport that wedges without
 * closing (frames stop, socket stays "open") leaves it pending forever: the
 * doc never turns ready, and "unavailable" needs a peer to actually answer.
 * The retry re-issues the request after evicting the stuck load, which also
 * recovers the case where a reconnect dropped the original request.
 */
export async function findBounded<T>(
	repo: Repo,
	url: AutomergeUrl,
	{ maxMs = 30000, retries = 1 }: { maxMs?: number; retries?: number } = {},
): Promise<DocHandle<T>> {
	for (let attempt = 0; ; attempt++) {
		const ctl = new AbortController();
		const timer = setTimeout(
			() => ctl.abort(new Error(`fetching ${url} timed out after ${maxMs}ms`)),
			maxMs,
		);
		try {
			return await repo.find<T>(url, { signal: ctl.signal });
		} catch (err) {
			if (!ctl.signal.aborted || attempt >= retries) throw err;
			dlog("findBounded: %s timed out; evicting and retrying", url);
			try {
				await repo.removeFromCache(parseAutomergeUrl(url).documentId);
			} catch {
				// eviction is best-effort; the retry may still hit the stuck load
			}
		} finally {
			clearTimeout(timer);
		}
	}
}

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
	/**
	 * Docs changed this run whose delivery the server hadn't confirmed before
	 * the deadline (set by the CLI's confirm pass, not by waitForServerSync).
	 * They finish uploading during the shutdown quiesce or on the next sync.
	 */
	unconfirmed?: number;
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

/**
 * Resolve the server peer and the key under which `DocHandle.getSyncInfo`
 * tracks its advertised heads. Subduction keys sync info by the peer id
 * itself; classic sync keys it by the peer's announced storageId — `syncKey`
 * is undefined until the relevant handshake has completed (and stays
 * undefined for a legacy relay that never announces a storageId).
 */
async function serverSyncTarget(
	repo: Repo,
	backend: Backend,
): Promise<{ peerId?: string; syncKey?: string }> {
	if (backend === "subduction") {
		const peerId = await connectedServerPeer(repo);
		return { peerId, syncKey: peerId };
	}
	const peerId = repo.peers[0];
	if (peerId === undefined) return {};
	return { peerId, syncKey: repo.getStorageIdOfPeer(peerId) };
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
	if (backend !== "subduction") {
		// Legacy: the WebSocketClientAdapter connects asynchronously and there is
		// no subduction handshake to observe — wait for the classic "peer" event
		// instead. Without this gate, a command's local settle (~1.5s) can finish
		// before the socket even opens, and the repo shuts down having sent
		// nothing (the legacy-flake family: clone-after-init unavailable, yeet
		// never delivered).
		const firstPeer = () => repo.peers[0] as string | undefined;
		if (firstPeer() !== undefined) {
			return { connected: true, connectMs: 0, serverPeerId: firstPeer() };
		}
		const connected = await new Promise<boolean>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const net = repo.networkSubsystem;
			const onPeer = () => {
				if (timer) clearTimeout(timer);
				net.off("peer", onPeer);
				resolve(true);
			};
			net.on("peer", onPeer);
			timer = setTimeout(() => {
				net.off("peer", onPeer);
				resolve(firstPeer() !== undefined);
			}, maxMs);
		});
		return {
			connected,
			connectMs: Date.now() - start,
			serverPeerId: connected ? firstPeer() : undefined,
		};
	}
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
 * The legacy backend speaks the classic sync protocol, but a relay that
 * announces a storageId (the stock automerge sync server does) still yields
 * per-doc sync info — so both backends get the same push-confirmed verdict.
 * Only a relay without a storageId falls back to {@link waitForSync}'s
 * local settle.
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
	const isConnected = () =>
		backend === "subduction"
			? repo.isSubductionConnected()
			: repo.peers.length > 0;

	const documentId = handle.documentId;
	dlog("waitForServerSync url=%s idleMs=%d maxMs=%d", handle.url, idleMs, maxMs);

	// Wake the poll loop the instant the server advertises new heads for this doc
	// (otherwise we just notice on the next poll tick). Subduction advertises via
	// the repo-level event; classic sync via the handle-level one.
	let wake: (() => void) | null = null;
	const onRemoteHeads = (p: { documentId: string }) => {
		if (p.documentId === documentId) wake?.();
	};
	repo.on("subduction-remote-heads", onRemoteHeads);
	const onHandleRemoteHeads = () => wake?.();
	handle.on("remote-heads", onHandleRemoteHeads);

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

			const { peerId: serverPeerId, syncKey } = await serverSyncTarget(
				repo,
				backend,
			);

			// A legacy relay that never announces a storageId can't be
			// push-confirmed at all — settle locally for the remaining budget
			// (the pre-verdict legacy behavior).
			if (backend !== "subduction" && serverPeerId && syncKey === undefined) {
				dlog("waitForServerSync legacy peer has no storageId; settling url=%s", handle.url);
				await waitForSync(handle, {
					idleMs,
					maxMs: Math.max(pollMs, maxMs - (now - start)),
				});
				return {
					url: handle.url,
					synced: true,
					pending: false,
					connected: true,
					serverPeerId,
					localHeads: headsOf(),
					serverHeads: [],
				};
			}

			let serverHeads: string[] = [];
			let synced = false;
			let pending = false;
			if (syncKey) {
				const info = handle.getSyncInfo(syncKey as never);
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
					connected: isConnected(),
					serverPeerId,
					localHeads: headsOf(),
					serverHeads,
				};
			}

			// Behind for a while and the scheduler isn't catching us up — re-arm a
			// single fresh sync round (the technique's stuck-doc nudge, without the
			// full per-doc exponential backoff a long-lived client would keep).
			if (
				backend === "subduction" &&
				!resynced &&
				serverPeerId &&
				now - start >= resyncAfterMs
			) {
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
		handle.off("remote-heads", onHandleRemoteHeads);
	}
}

/**
 * Drain-style delivery confirmation for a set of docs written earlier in this
 * command: one repo-level listener + one loop, instead of a poll loop per doc
 * (which convoys on the slowest doc in each batch). A doc counts as confirmed
 * when the server's advertised heads cover its Automerge frontier — the same
 * push-confirmation rule as {@link waitForServerSync}, minus the local-settle
 * gate (nothing local is racing; the writes happened before this call).
 *
 * The server advertises heads on its own sync schedule, not as a per-doc
 * receipt, so stragglers get a collective `resyncSubduction` nudge after
 * `nudgeAfterMs`, and again on every stall (no confirmation for `stallMs`)
 * up to `retries` times. When retries are exhausted, `onStalled` is consulted:
 * resolve true to keep waiting (retries reset), false to give up and report
 * the remainder — the CLI wires this to an interactive prompt, so a user can
 * choose to keep waiting out a slow server or bail to PENDING. A legacy relay
 * without a storageId can't confirm anything; delivery is entrusted to the
 * shutdown quiesce as before.
 */
export async function confirmDelivery(
	repo: Repo,
	handles: readonly DocHandle<unknown>[],
	backend: Backend,
	{
		stallMs = 10000,
		nudgeAfterMs = 3000,
		pollMs = 500,
		retries = 2,
		onProgress,
		onStalled,
	}: {
		stallMs?: number;
		nudgeAfterMs?: number;
		pollMs?: number;
		/** Extra nudge rounds after a stall before consulting `onStalled`. */
		retries?: number;
		onProgress?: (confirmed: number, total: number) => void;
		/** Called when retries are exhausted; true = keep waiting, false = bail. */
		onStalled?: (unconfirmed: number, total: number) => Promise<boolean>;
	} = {},
): Promise<{ unconfirmed: number }> {
	const pending = new Map<string, DocHandle<unknown>>();
	for (const h of handles) pending.set(h.documentId, h);
	const total = pending.size;
	if (total === 0) return { unconfirmed: 0 };

	const isConfirmed = (h: DocHandle<unknown>, syncKey: string): boolean => {
		const info = h.getSyncInfo(syncKey as never);
		if (!info || info.lastHeads.length === 0) return false;
		const advertised = new Set<string>(info.lastHeads);
		const frontier = [...(h.heads() ?? [])] as string[];
		return frontier.length > 0 && frontier.every((x) => advertised.has(x));
	};

	// One wake channel for all docs: repo-level for subduction, handle-level
	// for classic sync.
	let wake: (() => void) | null = null;
	const onRepoRemoteHeads = (p: { documentId: string }) => {
		if (pending.has(p.documentId)) wake?.();
	};
	repo.on("subduction-remote-heads", onRepoRemoteHeads);
	const handleListeners: Array<[DocHandle<unknown>, () => void]> = [];
	for (const h of pending.values()) {
		const fn = () => wake?.();
		h.on("remote-heads", fn);
		handleListeners.push([h, fn]);
	}

	const nudgePending = (viaClaim: boolean) => {
		for (const h of pending.values()) {
			if (viaClaim && !claimResync(repo, h.documentId)) continue;
			try {
				repo.resyncSubduction(h.documentId);
			} catch {
				// no Subduction source / doc not attached
			}
		}
	};

	const start = Date.now();
	let lastCount = total;
	let lastProgress = start;
	let nudged = false;
	let retriesLeft = retries;
	try {
		for (;;) {
			const { peerId, syncKey } = await serverSyncTarget(repo, backend);
			if (syncKey) {
				for (const [id, h] of pending) {
					if (isConfirmed(h, syncKey)) pending.delete(id);
				}
			} else if (backend !== "subduction" && peerId) {
				// Relay never announces a storageId: unconfirmable by design;
				// trust the settle + shutdown quiesce (pre-verdict legacy behavior).
				dlog("confirmDelivery: legacy relay has no storageId; trusting quiesce");
				return { unconfirmed: 0 };
			}

			const now = Date.now();
			if (pending.size < lastCount) {
				lastCount = pending.size;
				lastProgress = now;
				onProgress?.(total - pending.size, total);
			}
			if (pending.size === 0) return { unconfirmed: 0 };

			// The server stores long before it advertises; prod it once for the
			// stragglers instead of waiting out its gossip schedule.
			if (backend === "subduction" && !nudged && now - start >= nudgeAfterMs) {
				nudged = true;
				nudgePending(true);
				dlog("confirmDelivery: nudged %d stragglers", pending.size);
			}

			if (now - lastProgress >= stallMs) {
				if (retriesLeft > 0) {
					retriesLeft--;
					lastProgress = now;
					if (backend === "subduction") nudgePending(false);
					dlog(
						"confirmDelivery: stall retry (%d left) with %d/%d unconfirmed",
						retriesLeft,
						pending.size,
						total,
					);
					continue;
				}
				if (onStalled && (await onStalled(pending.size, total))) {
					retriesLeft = retries;
					lastProgress = Date.now();
					if (backend === "subduction") nudgePending(false);
					continue;
				}
				dlog(
					"confirmDelivery: stalled with %d/%d unconfirmed",
					pending.size,
					total,
				);
				return { unconfirmed: pending.size };
			}

			await sleepOrWake(pollMs, (fn) => {
				wake = fn;
			});
			wake = null;
		}
	} finally {
		repo.off("subduction-remote-heads", onRepoRemoteHeads);
		for (const [h, fn] of handleListeners) h.off("remote-heads", fn);
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
