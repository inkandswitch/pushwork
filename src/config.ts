import * as fs from "fs/promises";
import * as path from "path";
import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";

export type Backend = "legacy" | "subduction";

export interface PushworkConfig {
	rootUrl: AutomergeUrl;
	backend: Backend;
}

const DIR = ".pushwork";
const CONFIG = "config.json";
const HEADS = "heads.json";
const STORAGE = "storage";

export const pushworkDir = (root: string) => path.join(root, DIR);
export const storageDir = (root: string) => path.join(root, DIR, STORAGE);

export async function readConfig(root: string): Promise<PushworkConfig> {
	const text = await fs.readFile(path.join(root, DIR, CONFIG), "utf8");
	return JSON.parse(text) as PushworkConfig;
}

export async function writeConfig(
	root: string,
	config: PushworkConfig,
): Promise<void> {
	await fs.mkdir(path.join(root, DIR), { recursive: true });
	await fs.writeFile(
		path.join(root, DIR, CONFIG),
		JSON.stringify(config, null, 2) + "\n",
	);
}

export async function configExists(root: string): Promise<boolean> {
	try {
		await fs.access(path.join(root, DIR, CONFIG));
		return true;
	} catch {
		return false;
	}
}

export async function readHeads(root: string): Promise<UrlHeads | undefined> {
	try {
		const text = await fs.readFile(path.join(root, DIR, HEADS), "utf8");
		return JSON.parse(text) as UrlHeads;
	} catch {
		return undefined;
	}
}

export async function writeHeads(
	root: string,
	heads: UrlHeads,
): Promise<void> {
	await fs.mkdir(path.join(root, DIR), { recursive: true });
	await fs.writeFile(
		path.join(root, DIR, HEADS),
		JSON.stringify(heads) + "\n",
	);
}
