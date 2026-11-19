import {
	isImmutableString,
	isValidAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
} from "@automerge/automerge-repo";
import { flattenLeaves, type Shape } from "../shapes/index.js";
import { canonicalUrl } from "./clones.js";

const DIRECTORY_RESERVED = new Set(["@patchwork", "lastSyncAt"]);

/**
 * Every doc that makes up the tree under `root`: the root, its folder docs,
 * and its leaves. Folder and directory docs are walked the way Patchwork's
 * children plugins walk them, so a draft forked here records the same docs as
 * one forked in Patchwork; the shape's own leaves are added for custom shapes.
 */
export async function treeMembers(
	repo: Repo,
	shape: Shape,
	root: DocHandle<unknown>,
): Promise<AutomergeUrl[]> {
	const seen = new Set<AutomergeUrl>();
	const visit = async (handle: DocHandle<unknown>): Promise<void> => {
		const url = canonicalUrl(handle.url);
		if (seen.has(url)) return;
		seen.add(url);
		for (const child of childrenOf(handle.doc())) {
			if (seen.has(child.url)) continue;
			if (child.folder) await visit(await repo.find<unknown>(child.url));
			else seen.add(child.url);
		}
	};
	await visit(root);
	for (const url of flattenLeaves(await shape.decode({ repo, root })).values()) {
		seen.add(canonicalUrl(url));
	}
	return [...seen];
}

type Child = { url: AutomergeUrl; folder: boolean };

function childrenOf(doc: unknown): Child[] {
	if (!doc || typeof doc !== "object") return [];
	const record = doc as Record<string, unknown>;
	const type = asString((record["@patchwork"] as Record<string, unknown> | undefined)?.type);
	if (type === "folder") {
		const docs = Array.isArray(record.docs) ? (record.docs as Record<string, unknown>[]) : [];
		return docs.flatMap((link) => {
			const url = asUrl(link?.url);
			return url ? [{ url, folder: asString(link.type) === "folder" }] : [];
		});
	}
	if (type === "directory") {
		return Object.entries(record).flatMap(([key, value]) => {
			if (DIRECTORY_RESERVED.has(key)) return [];
			const url = asUrl(value);
			return url ? [{ url, folder: false }] : [];
		});
	}
	return [];
}

function asString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (isImmutableString(value)) return String(value);
	return undefined;
}

function asUrl(value: unknown): AutomergeUrl | undefined {
	const s = asString(value);
	return s !== undefined && isValidAutomergeUrl(s) ? canonicalUrl(s) : undefined;
}
