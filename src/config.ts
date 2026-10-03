import * as fs from "fs/promises";
import * as path from "path";
import { stripHeads, type AutomergeUrl } from "./url.js";

export const CONFIG_VERSION = 6;

export interface PushworkConfig {
	version: typeof CONFIG_VERSION;
	rootUrl: AutomergeUrl;
	shape: string;
	artifactDirectories: string[];
	server?: string;
	publishGroup?: string;
}

const DIR = ".pushwork";
const CONFIG = "config.json";
const STORAGE = "storage";

export const pushworkDir = (root: string) => path.join(root, DIR);
export const storageDir = (root: string) => path.join(root, DIR, STORAGE);

// fields of the configs written by pushwork 1 and 2
type OldConfig = {
	version?: number;
	rootUrl?: string;
	root_directory_url?: string;
	shape?: string;
	backend?: string;
	subduction?: boolean;
};

function oldVersionError(old: OldConfig): Error {
	const original = old.version === undefined && old.rootUrl === undefined;
	if (old.backend === "legacy" || (original && !old.subduction)) {
		return new Error(
			"this repo's data is on the retired sync3 server; `rm -rf .pushwork && pushwork init` republishes it as a new repo",
		);
	}
	const url = old.rootUrl ?? old.root_directory_url ?? "<rootUrl>";
	const shape = old.shape ?? (original ? "patchwork-folder" : "vfs");
	return new Error(
		`pushwork 3 uses a new storage format. Run \`npx pushwork@2 sync\` to publish any local edits, then \`pushwork clone ${url} <newdir> --shape ${shape}\``,
	);
}

export async function readConfig(root: string): Promise<PushworkConfig> {
	const text = await fs.readFile(path.join(root, DIR, CONFIG), "utf8");
	const parsed = JSON.parse(text);
	if (parsed.version !== CONFIG_VERSION) throw oldVersionError(parsed);
	if (!parsed.rootUrl) throw new Error("pushwork config missing rootUrl");
	if (!parsed.shape) throw new Error("pushwork config missing shape");
	return {
		version: CONFIG_VERSION,
		// the root is always opened live so sync can change it
		rootUrl: stripHeads(parsed.rootUrl),
		shape: parsed.shape,
		artifactDirectories: parsed.artifactDirectories ?? [],
		server: parsed.server,
		publishGroup: parsed.publishGroup,
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
