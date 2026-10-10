import * as net from "net";
import { WebSocketServer, type WebSocket } from "ws";
import {
	MemorySigner,
	MemoryStorage,
	Subduction,
	setSubductionLogLevel,
	type Policy,
	type Transport,
} from "@automerge/automerge-subduction";

function transport(ws: WebSocket, stalled: () => boolean): Transport {
	const queue: Uint8Array[] = [];
	const waiters: { resolve(b: Uint8Array): void; reject(e: Error): void }[] = [];
	const onClose: (() => void)[] = [];
	let closed = false;
	ws.on("message", (data: Buffer) => {
		if (stalled()) return;
		const bytes = new Uint8Array(data);
		const waiter = waiters.shift();
		if (waiter) waiter.resolve(bytes);
		else queue.push(bytes);
	});
	ws.on("close", () => {
		closed = true;
		for (const w of waiters.splice(0)) w.reject(new Error("closed"));
		for (const f of onClose) f();
	});
	return {
		sendBytes: async bytes => {
			if (!stalled()) ws.send(bytes);
		},
		recvBytes: () => {
			if (queue.length) return Promise.resolve(queue.shift()!);
			if (closed) return Promise.reject(new Error("closed"));
			return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
		},
		disconnect: async () => ws.close(),
		onDisconnect: f => onClose.push(f),
	};
}

// A Subduction sync server on an ephemeral port, backed by memory. After stall() it
// keeps its connections open but never answers.
export async function startServer(policy?: Policy): Promise<{ url: string; stall(): void; close(): Promise<void> }> {
	setSubductionLogLevel("error");
	const node = new Subduction({ signer: MemorySigner.generate(), storage: new MemoryStorage(), policy });
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise(resolve => wss.once("listening", resolve));
	const { port } = wss.address() as { port: number };
	// The service name must equal the client's URL.host or the handshake fails.
	const host = `127.0.0.1:${port}`;
	let stalled = false;
	wss.on("connection", ws => {
		ws.binaryType = "nodebuffer";
		node.acceptTransport(transport(ws, () => stalled), host).catch(() => ws.terminate());
	});
	return {
		url: `ws://${host}`,
		stall: () => {
			stalled = true;
		},
		async close() {
			for (const ws of wss.clients) ws.terminate();
			await new Promise(resolve => wss.close(resolve));
			await node.disconnectAll();
			node.free();
		},
	};
}

// Accepts TCP connections and never answers; counts how many it got.
export async function startSilentServer(): Promise<{ url: string; connections(): number; close(): Promise<void> }> {
	const sockets = new Set<net.Socket>();
	let count = 0;
	const server = net.createServer(socket => {
		count++;
		sockets.add(socket);
		// Windows resets the connection when the client process exits
		socket.on("error", () => {});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as net.AddressInfo;
	return {
		url: `ws://127.0.0.1:${port}`,
		connections: () => count,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise(resolve => server.close(resolve));
		},
	};
}
