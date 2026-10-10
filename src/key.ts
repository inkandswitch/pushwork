import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { MemorySigner } from "@automerge/automerge-subduction";

// 32-byte ed25519 seed stored as 64 hex characters, created on first use
export async function loadSeed(): Promise<Uint8Array> {
	const file = path.join(os.homedir(), ".pushwork", "key");
	const text = await fs.readFile(file, "utf8").catch(e => {
		if (e.code === "ENOENT") return null;
		throw e;
	});
	if (text !== null) {
		const hex = text.trim();
		if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`malformed key file: ${file}`);
		return new Uint8Array(Buffer.from(hex, "hex"));
	}
	const seed = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${crypto.randomUUID()}.tmp`;
	await fs.writeFile(tmp, seed.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
	// link, not rename: if another process got there first, use its key
	await fs.link(tmp, file).catch(e => {
		if (e.code !== "EEXIST") throw e;
	});
	await fs.unlink(tmp);
	return loadSeed();
}

export const signerFrom = (seed: Uint8Array) => MemorySigner.fromBytes(seed);
