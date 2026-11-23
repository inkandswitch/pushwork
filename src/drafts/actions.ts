// Adapted from strand's `drafts/src/overlay-actions.ts` and
// `providers/overlay-list.ts`. A root's drafts are listed on its overlay
// index (`@patchwork.overlaysUrl`); main is null and is always called main.
import {
	isValidAutomergeUrl,
	parseAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
} from "@automerge/automerge-repo";
import {
	DRAFT_NAME,
	isDraftDoc,
	isMergeDoc,
	type CloneEntry,
	type DraftDoc,
	type HasOverlays,
	type OverlayIndex,
} from "./types.js";
import { canonicalUrl } from "./clones.js";
import { forkPoints, writableCopy } from "./forks.js";

/** The name that always means the root itself. */
export const MAIN = "main";

/** One listed draft, as {@link listDrafts} gives it. */
export type DraftSummary = {
	url: AutomergeUrl;
	// The nearest draft it was forked off that's still listed; null for main.
	parent: AutomergeUrl | null;
	name: string;
	// How many listed drafts it's beneath; 0 for one forked off main.
	depth: number;
};

/** The root's index, made the first time it's needed. */
export async function ensureIndex(
	repo: Repo,
	root: DocHandle<HasOverlays>,
): Promise<DocHandle<OverlayIndex>> {
	const existing = await findIndex(repo, root);
	if (existing) return existing;
	const index = repo.create<OverlayIndex>({
		"@patchwork": { type: "overlay-index" },
		drafts: [],
		merges: [],
	});
	root.change((d: HasOverlays) => {
		// Mutate `@patchwork` in place. Reassigning a spread would carry
		// references to existing Automerge objects into a new object.
		if (!d["@patchwork"]) d["@patchwork"] = {};
		d["@patchwork"]!.overlaysUrl = index.url;
	});
	return index;
}

export async function findIndex(
	repo: Repo,
	root: DocHandle<HasOverlays>,
): Promise<DocHandle<OverlayIndex> | null> {
	const url = root.doc()?.["@patchwork"]?.overlaysUrl;
	return url && isValidAutomergeUrl(url) ? repo.find<OverlayIndex>(url) : null;
}

/**
 * Every listed draft of `root`, in tree order: each draft, then the drafts
 * forked off it, in the order they were made. Drafts that aren't here yet
 * (made elsewhere and not synced) are left out.
 */
export async function listDrafts(
	repo: Repo,
	root: DocHandle<HasOverlays>,
): Promise<DraftSummary[]> {
	const index = await findIndex(repo, root);
	const urls = (index?.doc()?.drafts ?? []).filter(isValidAutomergeUrl);
	const docs = new Map<AutomergeUrl, DraftDoc>();
	for (const url of urls) {
		const doc = await findDraft(repo, url);
		if (doc) docs.set(url, doc);
	}
	// The nearest listed draft up from `parent`, through drafts that aren't
	// listed any more.
	const listedParent = async (parent: AutomergeUrl | null) => {
		const seen = new Set<AutomergeUrl>();
		let cursor = parent;
		while (cursor && !docs.has(cursor) && !seen.has(cursor)) {
			seen.add(cursor);
			cursor = (await findDraft(repo, cursor))?.parent ?? null;
		}
		return cursor;
	};
	const children = new Map<AutomergeUrl | null, AutomergeUrl[]>();
	const parents = new Map<AutomergeUrl, AutomergeUrl | null>();
	for (const [url, doc] of docs) {
		const parent = await listedParent(doc.parent);
		parents.set(url, parent);
		children.set(parent, [...(children.get(parent) ?? []), url]);
	}
	const out: DraftSummary[] = [];
	const visit = (parent: AutomergeUrl | null, depth: number) => {
		for (const url of children.get(parent) ?? []) {
			out.push({ url, parent, name: docs.get(url)!.name ?? DRAFT_NAME, depth });
			visit(url, depth + 1);
		}
	};
	visit(null, 0);
	return out;
}

async function findDraft(repo: Repo, url: AutomergeUrl): Promise<DraftDoc | undefined> {
	try {
		const doc = (await repo.find<DraftDoc>(url)).doc();
		return isDraftDoc(doc) ? doc : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The draft `ref` names: `main` (null), a draft's name, its url, or a unique
 * prefix of its document id.
 */
export async function resolveDraft(
	repo: Repo,
	root: DocHandle<HasOverlays>,
	ref: string,
): Promise<AutomergeUrl | null> {
	if (ref === MAIN) return null;
	const drafts = await listDrafts(repo, root);
	const named = drafts.filter((d) => d.name === ref);
	if (named.length === 1) return named[0].url;
	if (named.length > 1) {
		throw new Error(
			`more than one draft is named "${ref}"; use its url instead:\n` +
				named.map((d) => `  ${d.url}`).join("\n"),
		);
	}
	const id = ref.replace(/^automerge:/, "");
	const byId = id
		? drafts.filter((d) => parseAutomergeUrl(d.url).documentId.startsWith(id))
		: [];
	if (byId.length === 1) return byId[0].url;
	if (byId.length > 1) throw new Error(`"${ref}" matches more than one draft`);
	throw new Error(`no draft named "${ref}"`);
}

/** The display name of a draft, or `main`. */
export async function draftName(repo: Repo, draftUrl: AutomergeUrl | null): Promise<string> {
	if (!draftUrl) return MAIN;
	return (await repo.find<DraftDoc>(draftUrl)).doc()?.name ?? DRAFT_NAME;
}

/** Whether `draftUrl` is on the root's list. */
export async function isListed(
	repo: Repo,
	root: DocHandle<HasOverlays>,
	draftUrl: AutomergeUrl,
): Promise<boolean> {
	return (await listDrafts(repo, root)).some((d) => d.url === draftUrl);
}

/**
 * Fork `parentUrl` (null = main) as a new draft and return it. Forking clones
 * nothing: the new draft records, per doc, which version it branches off, and
 * reads that until the doc's first edit clones it. `mainUrls` are the docs of
 * main's tree.
 */
export async function forkDraft(
	repo: Repo,
	root: DocHandle<HasOverlays>,
	mainUrls: AutomergeUrl[],
	parentUrl: AutomergeUrl | null,
	name?: string,
): Promise<AutomergeUrl> {
	if (name !== undefined) checkName(name, await listDrafts(repo, root));
	const index = await ensureIndex(repo, root);
	const clones = await forkPoints(repo, mainUrls, parentUrl);
	const draft = repo.create<DraftDoc>({
		"@patchwork": { type: "draft" },
		...(name !== undefined ? { name } : {}),
		parent: parentUrl,
		clones,
	});
	index.change((d: OverlayIndex) => {
		d.drafts.push(draft.url);
	});
	return draft.url;
}

/**
 * Merge a draft into the draft it was forked off (the nearest one still
 * listed, or main), then take it off the list with every merge it's in.
 * Returns where it landed (null for main) and how many docs were merged.
 */
export async function mergeIntoParent(
	repo: Repo,
	root: DocHandle<HasOverlays>,
	draftUrl: AutomergeUrl,
): Promise<{ landed: AutomergeUrl | null; merged: number }> {
	const listed = (await listDrafts(repo, root)).find((d) => d.url === draftUrl);
	if (!listed) throw new Error(`draft ${draftUrl} isn't listed`);
	const landed = listed.parent;
	const target = landed ? await repo.find<DraftDoc>(landed) : null;
	const draft = await repo.find<DraftDoc>(draftUrl);
	let merged = 0;
	for (const [url, entry] of Object.entries(draft.doc()?.clones ?? {}) as [
		AutomergeUrl,
		CloneEntry,
	][]) {
		if (!entry.cloneUrl) continue;
		const copy = await writableCopy(repo, target, url);
		if (canonicalUrl(copy.url) === canonicalUrl(entry.cloneUrl)) continue;
		copy.merge(await repo.find<unknown>(entry.cloneUrl));
		merged++;
	}
	await unlist(repo, root, draftUrl);
	return { landed, merged };
}

/**
 * Take a draft off the list, with every merge it's the source or target of.
 * Nothing is merged and its docs stay where they are; drafts forked off it
 * list under its parent.
 */
export async function deleteDraft(
	repo: Repo,
	root: DocHandle<HasOverlays>,
	draftUrl: AutomergeUrl,
): Promise<void> {
	await unlist(repo, root, draftUrl);
}

/** Rename a draft; names stay unique, and `main` is taken. */
export async function renameDraft(
	repo: Repo,
	root: DocHandle<HasOverlays>,
	draftUrl: AutomergeUrl,
	name: string,
): Promise<void> {
	const others = (await listDrafts(repo, root)).filter((d) => d.url !== draftUrl);
	checkName(name, others);
	(await repo.find<DraftDoc>(draftUrl)).change((d: DraftDoc) => {
		d.name = name;
	});
}

/**
 * Whether deleting the draft would lose work: it holds a doc it changed. A
 * clone whose doc moved past its fork point counts; one that was only opened
 * doesn't. A clone that can't be loaded counts, to be safe.
 */
export async function hasUnmergedChanges(repo: Repo, draftUrl: AutomergeUrl): Promise<boolean> {
	const doc = (await repo.find<DraftDoc>(draftUrl)).doc();
	for (const entry of Object.values(doc?.clones ?? {}) as CloneEntry[]) {
		if (!entry.cloneUrl) continue;
		try {
			const heads = (await repo.find<unknown>(entry.cloneUrl)).heads();
			if (!sameHeads(heads, entry.clonedAt)) return true;
		} catch {
			return true;
		}
	}
	return false;
}

async function unlist(
	repo: Repo,
	root: DocHandle<HasOverlays>,
	draftUrl: AutomergeUrl,
): Promise<void> {
	const index = await findIndex(repo, root);
	if (!index) return;
	const merges = new Set<AutomergeUrl>();
	for (const url of index.doc()?.merges ?? []) {
		try {
			const doc = (await repo.find<unknown>(url)).doc();
			if (isMergeDoc(doc) && (doc.source === draftUrl || doc.target === draftUrl)) {
				merges.add(url);
			}
		} catch {
			// Not here; the list leaves out a merge whose input is gone anyway.
		}
	}
	index.change((d: OverlayIndex) => {
		remove(d.drafts, draftUrl);
		for (const merge of merges) remove(d.merges, merge);
	});
}

function remove(list: AutomergeUrl[], url: AutomergeUrl): void {
	const i = list.indexOf(url);
	if (i >= 0) list.splice(i, 1);
}

function checkName(name: string, drafts: DraftSummary[]): void {
	if (!name.trim()) throw new Error("a draft needs a name");
	if (name === MAIN) throw new Error(`"${MAIN}" is the root's name`);
	if (name.startsWith("-")) throw new Error("a draft name can't start with -");
	if (drafts.some((d) => d.name === name)) {
		throw new Error(`a draft named "${name}" already exists`);
	}
}

function sameHeads(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((h) => b.includes(h));
}
