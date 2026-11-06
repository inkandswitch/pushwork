import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { encode } from "cbor-x"
import { afterEach, describe, expect, it } from "vitest"
import { RpcPeer, type Handler } from "../../src/rpc.js"

// unix socket paths are capped near 104 bytes on macOS
function socketPath(): string {
	const name = `pw-rpc-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
	if (process.platform === "win32") return `\\\\.\\pipe\\${name}`
	const base = os.tmpdir().length < 40 ? os.tmpdir() : "/tmp"
	return path.join(base, name)
}

const cleanup: (() => void)[] = []
afterEach(() => {
	while (cleanup.length) cleanup.pop()!()
})

async function pair(handle: Handler) {
	const p = socketPath()
	const server = net.createServer()
	const serverSide = new Promise<net.Socket>(resolve =>
		server.once("connection", resolve),
	)
	await new Promise<void>(resolve => server.listen(p, resolve))
	const clientSocket = net.connect(p)
	await new Promise<void>(resolve => clientSocket.once("connect", resolve))
	const serverSocket = await serverSide
	const host = new RpcPeer(serverSocket, handle)
	const client = new RpcPeer(clientSocket)
	cleanup.push(() => {
		clientSocket.destroy()
		serverSocket.destroy()
		server.close()
		if (process.platform !== "win32") fs.rmSync(p, { force: true })
	})
	return { host, client, serverSocket }
}

describe("RpcPeer", () => {
	it("round-trips bytes, maps and nested objects", async () => {
		const { client } = await pair(async (_m, args) => args)
		const input = [
			new Uint8Array([1, 2, 3]),
			new Map([["a", 1]]),
			{ x: [1, { y: "z" }] },
		]
		const out = (await client.call("echo", input)) as unknown[]
		expect(out[0]).toBeInstanceOf(Uint8Array)
		expect(Array.from(out[0] as Uint8Array)).toEqual([1, 2, 3])
		expect(out[1]).toBeInstanceOf(Map)
		expect(out[1]).toEqual(new Map([["a", 1]]))
		expect(out[2]).toEqual({ x: [1, { y: "z" }] })
	})

	it("calls back a function argument", async () => {
		const { client } = await pair(async (_m, args) =>
			(args[0] as (s: string) => Promise<string>)("hi"),
		)
		expect(await client.call("go", [async (s: string) => s + "!"])).toBe("hi!")
	})

	it("calls a function inside an object passed to a callback", async () => {
		const { client } = await pair(async (_m, args) =>
			(args[0] as (o: unknown) => Promise<unknown>)({ viewCode: () => "code" }),
		)
		const result = await client.call("go", [
			async (o: { viewCode: () => Promise<string> }) => o.viewCode(),
		])
		expect(result).toBe("code")
	})

	it("rethrows errors with their message", async () => {
		const { client } = await pair(async () => {
			throw new Error("nope")
		})
		await expect(client.call("x", [])).rejects.toThrow("nope")
	})

	it("rejects pending calls when the socket closes", async () => {
		const { client, serverSocket } = await pair(() => new Promise(() => {}))
		const pending = client.call("x", [])
		setTimeout(() => serverSocket.destroy(), 20)
		await expect(pending).rejects.toThrow("connection closed")
	})

	it("handles several frames split across chunks", async () => {
		const { client } = await pair(async (_m, args) => args[0])
		const big = "x".repeat(300_000)
		const results = await Promise.all([
			client.call("a", [big]),
			client.call("b", [1]),
			client.call("c", [big + "y"]),
		])
		expect(results).toEqual([big, 1, big + "y"])
	})

	it("does not leak an unhandled rejection from an unawaited callback", async () => {
		const seen: unknown[] = []
		const on = (e: unknown) => seen.push(e)
		process.on("unhandledRejection", on)
		try {
			let release!: () => void
			const gate = new Promise<void>(r => (release = r))
			const { client } = await pair(async (_m, args) => {
				await gate
				void (args[0] as () => Promise<void>)()
				return "done"
			})
			void client.call("go", [async () => {}]).catch(() => {})
			client.close()
			release()
			await new Promise(r => setTimeout(r, 50))
			expect(seen).toEqual([])
		} finally {
			process.off("unhandledRejection", on)
		}
	})

	it("closes the peer on a malformed frame", async () => {
		for (const payload of [null, { t: "result", id: 1, value: { $map: [1] } }]) {
			const { client, serverSocket } = await pair(async () => 0)
			const pending = client.call("x", [])
			void pending.catch(() => {})
			const body = encode(payload)
			const frame = Buffer.alloc(4 + body.length)
			frame.writeUInt32BE(body.length, 0)
			frame.set(body, 4)
			const closed = new Promise<void>(r => client.onClose(r))
			serverSocket.write(frame)
			await closed
			await expect(pending).rejects.toThrow("connection closed")
		}
	})

	it("does not mistake user objects for markers", async () => {
		const { client } = await pair(async (_m, args) => args)
		const input = [{ $fn: 3 }, { $map: [[1, 2]] }, { $obj: { $fn: 1 } }]
		expect(await client.call("echo", input)).toEqual(input)
	})
})
