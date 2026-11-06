import type * as net from "node:net"
import { decode, encode } from "cbor-x"

export type Handler = (method: string, args: unknown[]) => Promise<unknown>

type Message =
	| { t: "call"; id: number; method: string; args: unknown[] }
	| { t: "invoke"; id: number; fn: number; args: unknown[] }
	| { t: "result"; id: number; value: unknown }
	| { t: "error"; id: number; message: string; name: string }

const MAX_FRAME = 256 * 1024 * 1024
// a user object whose only key is one of these would read as a marker
const MARKERS = new Set(["$fn", "$map", "$obj"])

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== "object" || v === null) return false
	const proto = Object.getPrototypeOf(v)
	return proto === Object.prototype || proto === null
}

export class RpcPeer {
	private chunks: Buffer[] = []
	private buffered = 0
	// bytes the next frame needs in total, once its header has been read
	private need = 4
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

	/** Whether the connection has closed. */
	get isClosed(): boolean {
		return this.closed
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
			try {
				this.send({ ...msg, id, args: this.marshal(msg.args) as unknown[] })
			} catch (e) {
				this.pending.delete(id)
				throw e
			}
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
			const keys = Object.keys(out)
			return keys.length === 1 && MARKERS.has(keys[0]) ? { $obj: out } : out
		}
		return v
	}

	private unmarshal(v: unknown): unknown {
		if (Array.isArray(v)) return v.map(x => this.unmarshal(x))
		if (isPlainObject(v)) {
			const keys = Object.keys(v)
			const only = keys.length === 1 ? keys[0] : undefined
			if (only === "$obj" && isPlainObject(v.$obj)) {
				return this.unmarshalEntries(v.$obj)
			}
			if (only === "$map") {
				if (
					!Array.isArray(v.$map) ||
					!v.$map.every(e => Array.isArray(e) && e.length === 2)
				) {
					throw new Error("malformed map")
				}
				return new Map(
					(v.$map as [unknown, unknown][]).map(([k, x]) => [
						this.unmarshal(k),
						this.unmarshal(x),
					]),
				)
			}
			if (only === "$fn") {
				if (typeof v.$fn !== "number") throw new Error("malformed function")
				const fn = v.$fn
				return (...args: unknown[]) => {
					const p = this.request({ t: "invoke", fn, args })
					// callers may not await a callback; a closed socket mustn't crash us
					p.catch(() => {})
					return p
				}
			}
			return this.unmarshalEntries(v)
		}
		return v
	}

	private unmarshalEntries(v: Record<string, unknown>): Record<string, unknown> {
		const out: Record<string, unknown> = {}
		for (const [k, x] of Object.entries(v)) out[k] = this.unmarshal(x)
		return out
	}

	private onData(chunk: Buffer): void {
		if (this.closed) return
		this.chunks.push(chunk)
		this.buffered += chunk.length
		try {
			// concat once per frame, not once per chunk
			while (this.buffered >= this.need) {
				let buf = Buffer.concat(this.chunks)
				if (this.need === 4) {
					const len = buf.readUInt32BE(0)
					if (len > MAX_FRAME) throw new Error("frame too large")
					this.need = 4 + len
					if (this.buffered < this.need) {
						this.chunks = [buf]
						return
					}
				}
				const body = buf.subarray(4, this.need)
				buf = buf.subarray(this.need)
				this.chunks = buf.length ? [buf] : []
				this.buffered = buf.length
				this.need = 4
				this.onMessage(decode(body))
			}
		} catch {
			this.close()
		}
	}

	private onMessage(msg: unknown): void {
		if (!isPlainObject(msg) || typeof msg.id !== "number") {
			throw new Error("bad message")
		}
		const m = msg as Message
		if (m.t === "result" || m.t === "error") {
			const p = this.pending.get(m.id)
			if (!p) return
			// unmarshal first: if it throws, close() must still reject this call
			const value = m.t === "result" ? this.unmarshal(m.value) : undefined
			this.pending.delete(m.id)
			if (m.t === "result") p.resolve(value)
			else {
				const err = new Error(String(m.message))
				err.name = String(m.name)
				p.reject(err)
			}
			return
		}
		if (m.t !== "call" && m.t !== "invoke") throw new Error("bad message")
		void this.serve(m)
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
			try {
				this.send({ t: "error", id: msg.id, message: err.message, name: err.name })
			} catch {
				this.close()
			}
		}
	}
}
