import * as fs from "fs/promises";
import * as path from "path";
import { log } from "./log.js";

const dlog = log("stash");

export type StashKind = "modified" | "added" | "deleted";

export interface StashEntry {
	path: string;
	kind: StashKind;
	contentBase64?: string; // omitted for deleted
}

export interface Stash {
	id: number;
	name?: string;
	branch: string | null;
	createdAt: number;
	entries: StashEntry[];
}

const SNARF_DIR = path.join(".pushwork", "snarf");
const SNARF_INDEX = path.join(SNARF_DIR, "index.json");

async function readStashes(root: string): Promise<Stash[]> {
	try {
		const text = await fs.readFile(path.join(root, SNARF_INDEX), "utf8");
		const parsed = JSON.parse(text) as Stash[];
		if (!Array.isArray(parsed)) return [];
		return parsed;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

async function writeStashes(root: string, stashes: Stash[]): Promise<void> {
	await fs.mkdir(path.join(root, SNARF_DIR), { recursive: true });
	await fs.writeFile(
		path.join(root, SNARF_INDEX),
		JSON.stringify(stashes, null, 2) + "\n",
	);
}

function nextId(stashes: Stash[]): number {
	let max = 0;
	for (const s of stashes) if (s.id > max) max = s.id;
	return max + 1;
}

export async function listStashes(root: string): Promise<Stash[]> {
	const stashes = await readStashes(root);
	stashes.sort((a, b) => b.id - a.id); // newest first
	return stashes;
}

export async function appendStash(
	root: string,
	args: { name?: string; branch: string | null; entries: StashEntry[] },
): Promise<Stash> {
	const stashes = await readStashes(root);
	const id = nextId(stashes);
	const stash: Stash = {
		id,
		name: args.name,
		branch: args.branch,
		createdAt: Date.now(),
		entries: args.entries,
	};
	stashes.push(stash);
	await writeStashes(root, stashes);
	dlog("appendStash id=%d name=%s entries=%d", id, args.name ?? "(unnamed)", args.entries.length);
	return stash;
}

export async function takeStash(
	root: string,
	selector?: string,
): Promise<Stash | null> {
	const stashes = await readStashes(root);
	if (stashes.length === 0) return null;
	let idx: number;
	if (!selector) {
		// most recent
		idx = stashes.reduce((best, s, i) => (s.id > stashes[best].id ? i : best), 0);
	} else {
		const asInt = Number(selector);
		idx = stashes.findIndex((s) =>
			(!Number.isNaN(asInt) && s.id === asInt) || s.name === selector,
		);
		if (idx < 0) return null;
	}
	const [taken] = stashes.splice(idx, 1);
	await writeStashes(root, stashes);
	dlog("takeStash id=%d name=%s", taken.id, taken.name ?? "(unnamed)");
	return taken;
}

export function encodeBytes(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

export function decodeBytes(b64: string): Uint8Array {
	return new Uint8Array(Buffer.from(b64, "base64"));
}
