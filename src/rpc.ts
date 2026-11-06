import type * as net from "node:net"
import { decode, encode } from "cbor-x"

export type Handler = (method: string, args: unknown[]) => Promise<unknown>

type Message =
	| { t: "call"; id: number; method: string; args: unknown[] }
	| { t: "invoke"; id: number; fn: number; args: unknown[] }
	| { t: "result"; id: number; value: unknown }
	| { t: "error"; id: number; message: string; name: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== "object" || v === null) return false
	const proto = Object.getPrototypeOf(v)
	return proto === Object.prototype || proto === null
}

export class RpcPeer {
	private buffer = Buffer.alloc(0)
	private nextId = 1
	private pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>()
	// functions we handed to the other side, by the number it sees
	private exported = new Map<number, (...args: unknown[]) => unknown>()
	private nextFn = 1
	private closeCallbacks: (() => void)[] = []
	private closed = false

	constructor(
		private socket: net.Socket,
		private handle?: Handler,
	) {
		socket.on("data", chunk => this.onData(chunk))
		socket.on("error", () => {})
		socket.on("close", () => this.onClose())
		if (socket.destroyed) this.onClose()
	}

	call(method: string, args: unknown[]): Promise<unknown> {
		return this.request({ t: "call", method, args })
	}

	onClose(cb?: () => void): void {
		if (!cb) return this.finish()
		if (this.closed) cb()
		else this.closeCallbacks.push(cb)
	}

	close(): void {
		this.socket.destroy()
		this.finish()
	}

	private finish(): void {
		if (this.closed) return
		this.closed = true
		this.exported.clear()
		for (const p of this.pending.values()) {
			p.reject(new Error("connection closed"))
		}
		this.pending.clear()
		for (const cb of this.closeCallbacks.splice(0)) cb()
	}

	private request(
		msg: { t: "call"; method: string; args: unknown[] } | {
			t: "invoke"
			fn: number
			args: unknown[]
		},
	): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("connection closed"))
		const id = this.nextId++
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			this.send({ ...msg, id, args: this.marshal(msg.args) as unknown[] })
		})
	}

	private send(msg: Message): void {
		const body = encode(msg)
		const frame = Buffer.alloc(4 + body.length)
		frame.writeUInt32BE(body.length, 0)
		frame.set(body, 4)
		this.socket.write(frame)
	}

	private marshal(v: unknown): unknown {
		if (typeof v === "function") {
			const n = this.nextFn++
			this.exported.set(n, v as (...args: unknown[]) => unknown)
			return { $fn: n }
		}
		if (Array.isArray(v)) return v.map(x => this.marshal(x))
		// cbor-x writes a Map as a plain map and reads it back as an object
		if (v instanceof Map) {
			return { $map: [...v].map(([k, x]) => [this.marshal(k), this.marshal(x)]) }
		}
		if (isPlainObject(v)) {
			const out: Record<string, unknown> = {}
			for (const [k, x] of Object.entries(v)) out[k] = this.marshal(x)
			return out
		}
		return v
	}

	private unmarshal(v: unknown): unknown {
		if (Array.isArray(v)) return v.map(x => this.unmarshal(x))
		if (isPlainObject(v)) {
			const keys = Object.keys(v)
			if (keys.length === 1 && keys[0] === "$map" && Array.isArray(v.$map)) {
				return new Map(
					(v.$map as [unknown, unknown][]).map(([k, x]) => [
						this.unmarshal(k),
						this.unmarshal(x),
					]),
				)
			}
			if (keys.length === 1 && keys[0] === "$fn" && typeof v.$fn === "number") {
				const fn = v.$fn
				return (...args: unknown[]) => this.request({ t: "invoke", fn, args })
			}
			const out: Record<string, unknown> = {}
			for (const [k, x] of Object.entries(v)) out[k] = this.unmarshal(x)
			return out
		}
		return v
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk])
		while (this.buffer.length >= 4) {
			const len = this.buffer.readUInt32BE(0)
			if (this.buffer.length < 4 + len) return
			const body = this.buffer.subarray(4, 4 + len)
			this.buffer = this.buffer.subarray(4 + len)
			let msg: Message
			try {
				msg = decode(body) as Message
			} catch {
				this.close()
				return
			}
			this.onMessage(msg)
		}
	}

	private onMessage(msg: Message): void {
		if (msg.t === "result" || msg.t === "error") {
			const p = this.pending.get(msg.id)
			if (!p) return
			this.pending.delete(msg.id)
			if (msg.t === "result") p.resolve(this.unmarshal(msg.value))
			else {
				const err = new Error(msg.message)
				err.name = msg.name
				p.reject(err)
			}
			return
		}
		void this.serve(msg)
	}

	private async serve(msg: Message & { t: "call" | "invoke" }): Promise<void> {
		try {
			const args = this.unmarshal(msg.args) as unknown[]
			let value: unknown
			if (msg.t === "call") {
				if (!this.handle) throw new Error("no handler")
				value = await this.handle(msg.method, args)
			} else {
				const fn = this.exported.get(msg.fn)
				if (!fn) throw new Error(`unknown function ${msg.fn}`)
				value = await fn(...args)
			}
			if (!this.closed) {
				this.send({ t: "result", id: msg.id, value: this.marshal(value) })
			}
		} catch (e) {
			if (this.closed) return
			const err = e instanceof Error ? e : new Error(String(e))
			this.send({ t: "error", id: msg.id, message: err.message, name: err.name })
		}
	}
}
