/**
 * Node worker-thread host for {@link WorkerWebSocketEndpoint}.
 *
 * The upstream `sdn-workers` branch spawns a browser dedicated Worker
 * automatically, but throws in Node (`typeof Worker === "undefined"`).
 * This entry is the Node counterpart: ../repo.ts spawns it via
 * `worker_threads`, transfers one end of a `MessageChannel` in
 * `workerData`, and hands the other end to `WorkerWebSocketEndpoint`
 * (`{ worker: port }`). Node's `MessagePort` is an `EventTarget` with
 * `start()`, so it satisfies upstream's `WorkerPortLike` directly.
 *
 * The socket itself is Node's global `WebSocket` (Node >= 22), created by
 * upstream's `attachWebSocketHost` — all socket I/O, keepalive pongs, and
 * receive-credit buffering happen on this thread, so a busy main thread
 * (Wasm sync, fs) never stalls reads.
 *
 * Runs as compiled CommonJS (dist/workers/...), like the shard workers.
 */
import { workerData } from "worker_threads";
import type { MessagePort as NodeMessagePort } from "worker_threads";
import {
	attachWebSocketHost,
	type WorkerPortLike,
} from "@automerge/automerge-repo";

const { port } = workerData as { port: NodeMessagePort };

attachWebSocketHost(port as unknown as WorkerPortLike);
port.start();
