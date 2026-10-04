import * as fs from "fs/promises";
import * as path from "path";
import { type KeyhiveVersion, isKeyhiveVersion } from "./keyhive/common.js";
import { stripHeads, type AutomergeUrl } from "./url.js";

export const CONFIG_VERSION = 6;

export interface PushworkConfig {
	version: typeof CONFIG_VERSION;
	rootUrl: AutomergeUrl;
	shape: string;
	artifactDirectories: string[];
	/** Where document data syncs; unset means the default (or, for keyhive repos, the keyhive server). */
	syncServer?: string;
	/** A keyhive repo's keyhive server (a built-in name or url) and its contact card (a name or JSON). */
	keyhiveServer?: string;
	keyhiveCard?: string;
	/** A keyhive repo's automerge-repo-keyhive version; unset means 0.5, the only one there was. */
	keyhiveVersion?: KeyhiveVersion;
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
	artifactDirectories?: string[];
	artifact_directories?: string[];
};

export type Migratable = { rootUrl: string; shape: string; artifactDirectories?: string[] };

/** What `pushwork migrate` needs from a pre-v6 config, or undefined if it's current. */
export async function readOldConfig(root: string): Promise<Migratable | undefined> {
	const old: OldConfig = JSON.parse(await fs.readFile(path.join(root, DIR, CONFIG), "utf8"));
	if (old.version === CONFIG_VERSION) return undefined;
	const original = old.version === undefined && old.rootUrl === undefined;
	if (old.backend === "legacy" || (original && !old.subduction)) {
		throw new Error(
			"this repo's data is on the retired sync3 server; `rm -rf .pushwork && pushwork init` republishes it as a new repo",
		);
	}
	const rootUrl = old.rootUrl ?? old.root_directory_url ?? (await snapshotRootUrl(root));
	if (!rootUrl) throw new Error("old pushwork config has no root url");
	return {
		rootUrl,
		shape: old.shape ?? (original ? "patchwork-folder" : "vfs"),
		artifactDirectories: old.artifactDirectories ?? old.artifact_directories,
	};
}

// the original pushwork kept its root url in snapshot.json
async function snapshotRootUrl(root: string): Promise<string | undefined> {
	try {
		const snap = JSON.parse(await fs.readFile(path.join(root, DIR, "snapshot.json"), "utf8"));
		return snap.rootDirectoryUrl;
	} catch {
		return undefined;
	}
}

export async function readConfig(root: string): Promise<PushworkConfig> {
	const text = await fs.readFile(path.join(root, DIR, CONFIG), "utf8");
	const parsed = JSON.parse(text);
	if (parsed.version !== CONFIG_VERSION) {
		throw new Error(
			`pushwork config version ${parsed.version ?? "(none)"} is from pushwork 2 — run \`pushwork migrate\``,
		);
	}
	if (!parsed.rootUrl) throw new Error("pushwork config missing rootUrl");
	if (!parsed.shape) throw new Error("pushwork config missing shape");
	if (parsed.keyhiveVersion !== undefined && !isKeyhiveVersion(parsed.keyhiveVersion)) {
		throw new Error(`pushwork config has an unknown keyhiveVersion: ${parsed.keyhiveVersion}`);
	}
	return {
		version: CONFIG_VERSION,
		// the root is always opened live so sync can change it
		rootUrl: stripHeads(parsed.rootUrl),
		shape: parsed.shape,
		artifactDirectories: parsed.artifactDirectories ?? [],
		syncServer: parsed.syncServer,
		keyhiveServer: parsed.keyhiveServer,
		keyhiveCard: parsed.keyhiveCard,
		keyhiveVersion: parsed.keyhiveVersion,
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
