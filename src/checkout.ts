// What one checkout keeps of its own, now that documents live in one store per machine:
// the heads it last saw of each document, and a lock so two commands don't both write them.

import * as fs from "fs/promises";
import * as path from "path";
import { daemonPidFile, pushworkDir } from "./config.js";
import { lock, lockHolder } from "./lock.js";
import type { DocumentId } from "./url.js";

const VERSION = 1;

export const headsFile = (root: string) => path.join(pushworkDir(root), "heads.json");

/** The heads this checkout last saw, by document; none without a heads.json, so everything reads live. */
export async function readHeads(root: string): Promise<Map<DocumentId, string[]>> {
	const file = headsFile(root);
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw e;
	}
	const corrupt = (reason: string) =>
		new Error(`${file} is corrupt (${reason}); delete it and run \`pushwork sync\``);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw corrupt((e as Error).message);
	}
	const { version, heads } = (parsed ?? {}) as { version?: unknown; heads?: unknown };
	if (version !== VERSION) throw corrupt(`expected version ${VERSION}, got ${JSON.stringify(version)}`);
	if (typeof heads !== "object" || heads === null || Array.isArray(heads)) throw corrupt("no heads");
	const out = new Map<DocumentId, string[]>();
	for (const [id, h] of Object.entries(heads)) {
		if (!Array.isArray(h) || !h.every(x => typeof x === "string")) throw corrupt(`bad heads for ${id}`);
		out.set(id as DocumentId, h);
	}
	return out;
}

// written aside and renamed in, so a crash never leaves half a file
export async function writeHeads(root: string, heads: Map<DocumentId, string[]>): Promise<void> {
	const file = headsFile(root);
	const tmp = `${file}.${process.pid}`;
	await fs.writeFile(tmp, JSON.stringify({ version: VERSION, heads: Object.fromEntries(heads) }) + "\n");
	await fs.rename(tmp, file);
}

/**
 * Hold `.pushwork/checkout.lock` until the returned function is called. Held by the daemon, it
 * says so: the lock is the daemon's while it runs a command here, from any terminal.
 */
export async function lockCheckout(root: string): Promise<() => Promise<void>> {
	const file = path.join(pushworkDir(root), "checkout");
	try {
		return await lock(file);
	} catch (e) {
		// lock() says "in use" with a plain Error; anything with a code is a real failure
		if ((e as NodeJS.ErrnoException).code) throw e;
		const holder = await lockHolder(file);
		const daemon = Number(await fs.readFile(daemonPidFile(), "utf8").catch(() => "")) || 0;
		if (holder !== 0 && holder === daemon) {
			throw new Error(
				`the pushwork daemon (pid ${holder}) is still running a command in this checkout; wait for it, or run \`pushwork daemon stop\``,
			);
		}
		throw e;
	}
}
