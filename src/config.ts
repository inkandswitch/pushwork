import * as fs from "fs/promises";
import * as path from "path";
import type { AutomergeUrl } from "@automerge/automerge-repo";

export type Backend = "legacy" | "subduction";

export const CONFIG_VERSION = 2;

export interface PushworkConfig {
	version: typeof CONFIG_VERSION;
	rootUrl: AutomergeUrl;
	backend: Backend;
	shape: string;
	artifactDirectories: string[];
}

const DIR = ".pushwork";
const CONFIG = "config.json";
const STORAGE = "storage";

export const pushworkDir = (root: string) => path.join(root, DIR);
export const storageDir = (root: string) => path.join(root, DIR, STORAGE);

export async function readConfig(root: string): Promise<PushworkConfig> {
	const text = await fs.readFile(path.join(root, DIR, CONFIG), "utf8");
	const parsed = JSON.parse(text) as Partial<PushworkConfig>;
	if (parsed.version !== CONFIG_VERSION) {
		throw new Error(
			`pushwork config version mismatch: expected ${CONFIG_VERSION}, got ${parsed.version ?? "(missing)"}`,
		);
	}
	if (!parsed.rootUrl) throw new Error("pushwork config missing rootUrl");
	if (!parsed.backend) throw new Error("pushwork config missing backend");
	if (!parsed.shape) throw new Error("pushwork config missing shape");
	return {
		version: CONFIG_VERSION,
		rootUrl: parsed.rootUrl,
		backend: parsed.backend,
		shape: parsed.shape,
		artifactDirectories: parsed.artifactDirectories ?? [],
	};
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
