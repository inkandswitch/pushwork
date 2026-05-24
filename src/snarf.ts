import * as fs from "fs/promises";
import * as path from "path";
import { log } from "./log.js";

const dlog = log("snarf");

export type SnarfKind = "modified" | "added" | "deleted";

export interface SnarfEntry {
	path: string;
	kind: SnarfKind;
	contentBase64?: string; // omitted for deleted
}

export interface Snarf {
	id: number;
	name?: string;
	createdAt: number;
	entries: SnarfEntry[];
}

const SNARF_DIR = path.join(".pushwork", "snarf");
const SNARF_INDEX = path.join(SNARF_DIR, "index.json");

async function readSnarfs(root: string): Promise<Snarf[]> {
	try {
		const text = await fs.readFile(path.join(root, SNARF_INDEX), "utf8");
		const parsed = JSON.parse(text) as Snarf[];
		if (!Array.isArray(parsed)) return [];
		return parsed;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

async function writeSnarfs(root: string, snarfs: Snarf[]): Promise<void> {
	await fs.mkdir(path.join(root, SNARF_DIR), { recursive: true });
	await fs.writeFile(
		path.join(root, SNARF_INDEX),
		JSON.stringify(snarfs, null, 2) + "\n",
	);
}

function nextId(snarfs: Snarf[]): number {
	let max = 0;
	for (const s of snarfs) if (s.id > max) max = s.id;
	return max + 1;
}

export async function listSnarfs(root: string): Promise<Snarf[]> {
	const snarfs = await readSnarfs(root);
	snarfs.sort((a, b) => b.id - a.id); // newest first
	return snarfs;
}

export async function appendSnarf(
	root: string,
	args: { name?: string; entries: SnarfEntry[] },
): Promise<Snarf> {
	const snarfs = await readSnarfs(root);
	const id = nextId(snarfs);
	const snarf: Snarf = {
		id,
		name: args.name,
		createdAt: Date.now(),
		entries: args.entries,
	};
	snarfs.push(snarf);
	await writeSnarfs(root, snarfs);
	dlog("appendSnarf id=%d name=%s entries=%d", id, args.name ?? "(unnamed)", args.entries.length);
	return snarf;
}

export async function takeSnarf(
	root: string,
	selector?: string,
): Promise<Snarf | null> {
	const snarfs = await readSnarfs(root);
	if (snarfs.length === 0) return null;
	let idx: number;
	if (!selector) {
		// most recent
		idx = snarfs.reduce((best, s, i) => (s.id > snarfs[best].id ? i : best), 0);
	} else {
		const asInt = Number(selector);
		idx = snarfs.findIndex((s) =>
			(!Number.isNaN(asInt) && s.id === asInt) || s.name === selector,
		);
		if (idx < 0) return null;
	}
	const [taken] = snarfs.splice(idx, 1);
	await writeSnarfs(root, snarfs);
	dlog("takeSnarf id=%d name=%s", taken.id, taken.name ?? "(unnamed)");
	return taken;
}

export function encodeBytes(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

export function decodeBytes(b64: string): Uint8Array {
	return new Uint8Array(Buffer.from(b64, "base64"));
}
