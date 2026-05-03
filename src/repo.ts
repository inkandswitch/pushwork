import {
	Repo,
	initSubduction,
	type DocHandle,
	type NetworkAdapterInterface,
} from "@automerge/automerge-repo";
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";
import type { Backend } from "./config.js";

const DEFAULT_LEGACY = "wss://sync3.automerge.org";
const DEFAULT_SUBDUCTION = "wss://subduction.sync.inkandswitch.com";

export const legacyUrl = () =>
	process.env.PUSHWORK_LEGACY_SERVER || DEFAULT_LEGACY;
export const subductionUrl = () =>
	process.env.PUSHWORK_SUBDUCTION_SERVER || DEFAULT_SUBDUCTION;

export async function openRepo(
	backend: Backend,
	storageDir: string,
): Promise<Repo> {
	await initSubduction();
	const storage = new NodeFSStorageAdapter(storageDir);
	if (backend === "legacy") {
		const adapter = new WebSocketClientAdapter(
			legacyUrl(),
		) as unknown as NetworkAdapterInterface;
		return new Repo({ storage, network: [adapter] });
	}
	return new Repo({
		storage,
		network: [],
		subductionWebsocketEndpoints: [subductionUrl()],
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForSync<T>(
	handle: DocHandle<T>,
	{ idleMs = 1500, maxMs = 15000, pollMs = 200 } = {},
): Promise<void> {
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
		} else if (Date.now() - lastChange >= idleMs) {
			return;
		}
	}
}
