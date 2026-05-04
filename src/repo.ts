import {
	Repo,
	initSubduction,
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

export async function openRepo(
	backend: Backend,
	storageDir: string,
	opts: { offline?: boolean } = {},
): Promise<Repo> {
	dlog("openRepo backend=%s storage=%s offline=%s", backend, storageDir, !!opts.offline);
	await initSubduction();
	const storage = new NodeFSStorageAdapter(storageDir);
	if (opts.offline) {
		return new Repo({ storage, network: [] });
	}
	if (backend === "legacy") {
		const endpoint = legacyUrl();
		dlog("legacy ws endpoint=%s", endpoint);
		const adapter = new WebSocketClientAdapter(
			endpoint,
		) as unknown as NetworkAdapterInterface;
		return new Repo({ storage, network: [adapter] });
	}
	const endpoint = subductionUrl();
	dlog("subduction ws endpoint=%s", endpoint);
	return new Repo({
		storage,
		network: [],
		subductionWebsocketEndpoints: [endpoint],
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
