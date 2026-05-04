import * as fs from "fs/promises";
import * as path from "path";
import {
	type AutomergeUrl,
	type DocHandle,
	type Repo,
} from "@automerge/automerge-repo";
import { log } from "./log.js";

const dlog = log("branches");

export const META = "@patchwork";
export const DEFAULT_BRANCH = "default";

export type BranchesDoc = {
	"@patchwork": { type: "branches" };
	branches: { [name: string]: AutomergeUrl };
};

export const isBranchesDoc = (doc: unknown): doc is BranchesDoc => {
	if (!doc || typeof doc !== "object") return false;
	const meta = (doc as Record<string, unknown>)[META];
	return (
		!!meta &&
		typeof meta === "object" &&
		(meta as Record<string, unknown>).type === "branches"
	);
};

export function detectDocType(
	doc: unknown,
): "branches" | "folder" | "directory" | "unknown" {
	if (!doc || typeof doc !== "object") return "unknown";
	const meta = (doc as Record<string, unknown>)[META];
	if (!meta || typeof meta !== "object") return "unknown";
	const t = (meta as Record<string, unknown>).type;
	if (t === "branches" || t === "folder" || t === "directory") return t;
	return "unknown";
}

export async function resolveEffectiveRoot(
	repo: Repo,
	rootHandle: DocHandle<unknown>,
	branchName: string | null,
): Promise<DocHandle<unknown>> {
	const doc = rootHandle.doc();
	if (!isBranchesDoc(doc)) return rootHandle;
	if (!branchName) {
		throw new Error(
			"pushwork repo uses branches but no branch name is set",
		);
	}
	const url = doc.branches?.[branchName];
	if (!url) {
		throw new Error(
			`branch "${branchName}" not found in branches doc ${rootHandle.url}`,
		);
	}
	dlog("resolveEffectiveRoot branch=%s → %s", branchName, url);
	return repo.find<unknown>(url);
}

export function listBranchNames(branchesDoc: BranchesDoc): string[] {
	return Object.keys(branchesDoc.branches ?? {}).sort();
}

const BRANCH_FILE = path.join(".pushwork", "branch");

export async function readBranchFile(root: string): Promise<string | null> {
	try {
		const text = await fs.readFile(path.join(root, BRANCH_FILE), "utf8");
		return text.trim() || null;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export async function writeBranchFile(
	root: string,
	branchName: string,
): Promise<void> {
	await fs.mkdir(path.join(root, ".pushwork"), { recursive: true });
	await fs.writeFile(path.join(root, BRANCH_FILE), branchName + "\n");
}

export async function deleteBranchFile(root: string): Promise<void> {
	try {
		await fs.unlink(path.join(root, BRANCH_FILE));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}
