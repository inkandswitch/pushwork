/**
 * Unit tests for the sync-reliability helpers in `src/repo.ts` (isTransportError,
 * syncVerdict, claimResync, safeShutdown, waitForConnection). Fully offline —
 * safeShutdown/waitForConnection run against a tiny fake repo.
 */
import { describe, it, expect } from "vitest";
import type { Repo } from "@automerge/automerge-repo";
import {
	claimResync,
	isTransportError,
	safeShutdown,
	syncVerdict,
	waitForConnection,
} from "../../src/repo.js";

describe("isTransportError", () => {
	it("classifies dropped-connection blips as transport errors", () => {
		for (const e of [
			new Error("WebSocket is not open: readyState 3 (CLOSING)"),
			new Error("socket hang up"),
			new Error("read ECONNRESET"),
			new Error("connect ECONNREFUSED 127.0.0.1:443"),
			new Error("getaddrinfo ENOTFOUND sync.example.com"),
			new Error("Unexpected server response: 502"),
			"write EPIPE",
		]) {
			expect(isTransportError(e)).toBe(true);
		}
	});

	it("does not swallow genuine application errors", () => {
		for (const e of [
			new Error("pushwork already initialized at /tmp/x"),
			new Error("invalid automerge URL"),
			"nothing to cut: working tree clean",
			undefined,
			null,
			42,
		]) {
			expect(isTransportError(e)).toBe(false);
		}
	});
});

describe("syncVerdict", () => {
	const base = { localQuiet: true, pullComplete: true } as const;

	it("is synced only when settled, pull-complete, and push-confirmed", () => {
		expect(
			syncVerdict({ ...base, frontier: ["a", "b"], advertised: ["a", "b", "frag"] }),
		).toEqual({ synced: true, pending: false });
	});

	it("is pending when our frontier isn't advertised back yet", () => {
		expect(
			syncVerdict({ ...base, frontier: ["a", "b"], advertised: ["a"] }),
		).toEqual({ synced: false, pending: true });
	});

	it("is neither synced nor pending while still behind (pull incomplete)", () => {
		expect(
			syncVerdict({
				localQuiet: true,
				pullComplete: false,
				frontier: ["a"],
				advertised: ["a"],
			}),
		).toEqual({ synced: false, pending: false });
	});

	it("is neither while local heads are still unsettled", () => {
		expect(
			syncVerdict({
				localQuiet: false,
				pullComplete: true,
				frontier: ["a"],
				advertised: ["a"],
			}),
		).toEqual({ synced: false, pending: false });
	});
});

describe("claimResync", () => {
	it("returns true once per (repo, doc), then false", () => {
		const repoA = {} as unknown as Repo;
		const repoB = {} as unknown as Repo;

		expect(claimResync(repoA, "doc1")).toBe(true);
		expect(claimResync(repoA, "doc1")).toBe(false);
		// A different doc on the same repo is independent.
		expect(claimResync(repoA, "doc2")).toBe(true);
		// A different repo is independent.
		expect(claimResync(repoB, "doc1")).toBe(true);
		expect(claimResync(repoB, "doc1")).toBe(false);
	});
});

// ── Fake repo for teardown / connection timing ────────────────────────────

type Handler = (...args: unknown[]) => void;

function fakeRepo(init: {
	shutdown?: () => Promise<void>;
	connected?: boolean;
	peerIds?: string[];
}) {
	let connected = init.connected ?? false;
	const listeners = new Map<string, Set<Handler>>();
	const repo = {
		shutdown: init.shutdown ?? (async () => {}),
		isSubductionConnected: () => connected,
		connectedSubductionPeerIds: async () => init.peerIds ?? [],
		on: (event: string, fn: Handler) => {
			(listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(fn);
		},
		off: (event: string, fn: Handler) => {
			listeners.get(event)?.delete(fn);
		},
	};
	return {
		repo: repo as unknown as Repo,
		emitConnection(value: boolean) {
			connected = value;
			for (const fn of listeners.get("subduction-connection") ?? []) {
				fn({ connected: value });
			}
		},
		listenerCount() {
			return listeners.get("subduction-connection")?.size ?? 0;
		},
	};
}

describe("safeShutdown", () => {
	it("returns promptly even when repo.shutdown() hangs forever", async () => {
		const { repo } = fakeRepo({ shutdown: () => new Promise<void>(() => {}) });
		const start = Date.now();
		await safeShutdown(repo, { maxMs: 100 });
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(80);
		expect(elapsed).toBeLessThan(2000); // nowhere near the ~1-minute hang
	});

	it("swallows a WebSocket error thrown during shutdown", async () => {
		const { repo } = fakeRepo({
			shutdown: async () => {
				throw new Error("WebSocket was closed before the connection was established");
			},
		});
		await expect(safeShutdown(repo, { maxMs: 1000 })).resolves.toBeUndefined();
	});

	it("resolves immediately on a clean shutdown", async () => {
		let called = false;
		const { repo } = fakeRepo({
			shutdown: async () => {
				called = true;
			},
		});
		const start = Date.now();
		await safeShutdown(repo, { maxMs: 5000 });
		expect(called).toBe(true);
		expect(Date.now() - start).toBeLessThan(1000);
	});
});

describe("waitForConnection", () => {
	it("short-circuits on the legacy backend (no Subduction source)", async () => {
		const { repo } = fakeRepo({});
		await expect(waitForConnection(repo, "legacy")).resolves.toEqual({
			connected: false,
			connectMs: 0,
		});
	});

	it("reports 0ms and the server peer when already connected", async () => {
		const { repo } = fakeRepo({ connected: true, peerIds: ["server-peer"] });
		const conn = await waitForConnection(repo, "subduction");
		expect(conn).toEqual({
			connected: true,
			connectMs: 0,
			serverPeerId: "server-peer",
		});
	});

	it("resolves when the connection event fires, timing the handshake", async () => {
		const fake = fakeRepo({ peerIds: ["server-peer"] });
		const p = waitForConnection(fake.repo, "subduction", { maxMs: 5000 });
		setTimeout(() => fake.emitConnection(true), 60);
		const conn = await p;
		expect(conn.connected).toBe(true);
		expect(conn.serverPeerId).toBe("server-peer");
		expect(conn.connectMs).toBeGreaterThanOrEqual(40);
		expect(conn.connectMs).toBeLessThan(2000);
		expect(fake.listenerCount()).toBe(0); // listener removed on resolve
	});

	it("gives up (connected=false) after maxMs without hanging", async () => {
		const fake = fakeRepo({});
		const start = Date.now();
		const conn = await waitForConnection(fake.repo, "subduction", { maxMs: 120 });
		expect(conn.connected).toBe(false);
		expect(conn.serverPeerId).toBeUndefined();
		expect(Date.now() - start).toBeGreaterThanOrEqual(100);
		expect(fake.listenerCount()).toBe(0);
	});
});
