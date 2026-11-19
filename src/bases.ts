import * as fs from "fs/promises";
import * as path from "path";
import { parseAutomergeUrl, type AutomergeUrl } from "@automerge/automerge-repo";
import { pushworkDir } from "./config.js";
import { writeFileAtomic } from "./fs-tree.js";
import { log } from "./log.js";

const dlog = log("bases");

/**
 * The merge base of every tracked path: a heads-pinned URL of the version of
 * its document that the working-tree copy was last reconciled with. Sync's
 * three-way reconcile records a disk edit at these heads when the document
 * moved concurrently, so the edit merges instead of undoing the other one.
 *
 * Bases are this checkout's own bookkeeping, so they live locally in
 * `.pushwork/bases.json` rather than in the folder doc: folder links stay
 * bare (artifacts aside), and Patchwork opens what they link live and
 * editable.
 */
export type Bases = Map<string, AutomergeUrl>;

const FILE = "bases.json";

export async function readBases(root: string): Promise<Bases> {
	let text: string;
	try {
		text = await fs.readFile(path.join(pushworkDir(root), FILE), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw err;
	}
	try {
		return new Map(Object.entries(JSON.parse(text) as Record<string, AutomergeUrl>));
	} catch {
		dlog("unreadable %s; reconciling without merge bases", FILE);
		return new Map();
	}
}

export async function writeBases(root: string, bases: Bases): Promise<void> {
	const sorted = Object.fromEntries([...bases].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	await writeFileAtomic(
		path.join(pushworkDir(root), FILE),
		new TextEncoder().encode(JSON.stringify(sorted, null, 2) + "\n"),
	);
}

/**
 * The version to reconcile a folder link against: the recorded base when it
 * names the same document, else the link itself — pinned by an older
 * pushwork (so that pin is the base), or bare, in which case there is no
 * base and a disk edit applies at the tip.
 */
export function baseOf(link: AutomergeUrl, recorded: AutomergeUrl | undefined): AutomergeUrl {
	if (recorded && documentIdOf(recorded) === documentIdOf(link)) return recorded;
	return link;
}

const documentIdOf = (url: AutomergeUrl) => parseAutomergeUrl(url).documentId;
