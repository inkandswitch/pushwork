// Adapted from gaios-pkg-base `drafts/src/draft-actions.ts` and
// `draft-docs.ts`. The main draft is the one the root's
// `@patchwork.mainDraftUrl` points at; there is no flag for it.
import {
	isValidAutomergeUrl,
	parseAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
} from "@automerge/automerge-repo";
import { isDraftDoc, type CloneEntry, type DraftDoc, type HasDrafts } from "./types.js";
import { forkPoints, mergeDraft } from "./forks.js";

/** The name that always means the root itself. */
export const MAIN = "main";

/** One open draft, as listed by {@link listDrafts}. */
export type DraftSummary = {
	url: AutomergeUrl;
	// The draft it was forked off; null for a top-level draft (forked off main).
	parent: AutomergeUrl | null;
	name: string;
	depth: number;
};

/**
 * Every open draft of `root`, depth-first in creation order. Drafts that
 * aren't here yet (made elsewhere and not synced) are left out.
 */
export async function listDrafts(
	repo: Repo,
	root: DocHandle<HasDrafts>,
): Promise<DraftSummary[]> {
	const mainUrl = mainDraftUrlOf(root);
	const main = mainUrl ? await findDraft(repo, mainUrl) : undefined;
	if (!mainUrl || !main) return [];
	const out: DraftSummary[] = [];
	const seen = new Set<AutomergeUrl>([mainUrl]);
	const visit = async (doc: DraftDoc, parent: AutomergeUrl | null, depth: number) => {
		for (const url of (doc.drafts ?? []).filter(isValidAutomergeUrl)) {
			if (seen.has(url)) continue;
			seen.add(url);
			const child = await findDraft(repo, url);
			if (!child || child.mergedAt !== undefined) continue;
			out.push({ url, parent, name: child.name ?? "Draft", depth });
			await visit(child, url, depth + 1);
		}
	};
	await visit(main, null, 0);
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
	root: DocHandle<HasDrafts>,
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
	return (await repo.find<DraftDoc>(draftUrl)).doc()?.name ?? "Draft";
}

/**
 * Fork `parentUrl` (null = main) as a new child draft and return it. Forking
 * clones nothing: the new draft records, per doc, which version it branches
 * off, and reads that until the doc's first edit clones it. `mainUrls` are
 * the docs of main's tree.
 */
export async function forkDraft(
	repo: Repo,
	root: DocHandle<HasDrafts>,
	mainUrls: AutomergeUrl[],
	parentUrl: AutomergeUrl | null,
	name?: string,
): Promise<AutomergeUrl> {
	const drafts = await listDrafts(repo, root);
	if (name !== undefined) checkName(name, drafts);
	const clones = await forkPoints(repo, mainUrls, parentUrl);
	const mainDraft = await ensureMainDraft(repo, root);
	const parent = parentUrl ? await repo.find<DraftDoc>(parentUrl) : mainDraft;
	const draft = repo.create<DraftDoc>({
		"@patchwork": { type: "draft" },
		name: name ?? nextDefaultName(mainDraft, drafts),
		parent: parent.url,
		drafts: [],
		clones,
	});
	parent.change((d: DraftDoc) => {
		d.drafts.push(draft.url);
	});
	return draft.url;
}

/**
 * Merge a draft into the draft it was forked off (main for a top-level one).
 * Returns where it landed (null for main) and how many docs were merged.
 */
export async function mergeIntoParent(
	repo: Repo,
	root: DocHandle<HasDrafts>,
	draftUrl: AutomergeUrl,
): Promise<{ landed: AutomergeUrl | null; merged: number }> {
	const draft = await repo.find<DraftDoc>(draftUrl);
	const merged = await mergeDraft(repo, draft);
	return { landed: await landedOn(repo, root, draft.doc()?.parent), merged };
}

/**
 * Unlink a draft from its parent, which drops it, and every draft forked from
 * it, out of the list. Nothing is merged and its docs stay where they are.
 * Returns the parent, or null for main.
 */
export async function deleteDraft(
	repo: Repo,
	root: DocHandle<HasDrafts>,
	draftUrl: AutomergeUrl,
): Promise<AutomergeUrl | null> {
	const parentUrl = (await repo.find<DraftDoc>(draftUrl)).doc()?.parent;
	if (!parentUrl) return null;
	const parent = await repo.find<DraftDoc>(parentUrl);
	parent.change((d: DraftDoc) => {
		const i = d.drafts.indexOf(draftUrl);
		if (i >= 0) d.drafts.splice(i, 1);
	});
	return landedOn(repo, root, parentUrl);
}

/** Rename a draft; names stay unique, and `main` is taken. */
export async function renameDraft(
	repo: Repo,
	root: DocHandle<HasDrafts>,
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
 * Whether deleting the draft would lose work: it, or a draft forked from it,
 * holds a doc it changed that hasn't been merged. A clone whose doc moved
 * past its fork point counts; one that was only opened doesn't. A clone that
 * can't be loaded counts, to be safe.
 */
export async function hasUnmergedChanges(repo: Repo, draftUrl: AutomergeUrl): Promise<boolean> {
	const doc = (await repo.find<DraftDoc>(draftUrl)).doc();
	if (!doc || doc.mergedAt !== undefined) return false;
	for (const entry of Object.values(doc.clones ?? {}) as CloneEntry[]) {
		if (!entry.cloneUrl || entry.mergedAt) continue;
		try {
			const heads = (await repo.find<unknown>(entry.cloneUrl)).heads();
			if (!sameHeads(heads, entry.clonedAt)) return true;
		} catch {
			return true;
		}
	}
	for (const child of (doc.drafts ?? []).filter(isValidAutomergeUrl)) {
		if (await hasUnmergedChanges(repo, child)) return true;
	}
	return false;
}

/** Whether `draftUrl` is `ancestor` or was forked, at any depth, off it. */
export async function descendsFrom(
	repo: Repo,
	draftUrl: AutomergeUrl,
	ancestor: AutomergeUrl,
): Promise<boolean> {
	const seen = new Set<AutomergeUrl>();
	let cursor: AutomergeUrl | undefined = draftUrl;
	while (cursor && !seen.has(cursor)) {
		if (cursor === ancestor) return true;
		seen.add(cursor);
		const doc: DraftDoc | undefined = (await repo.find<DraftDoc>(cursor)).doc();
		if (!isDraftDoc(doc)) return false;
		cursor = doc.parent;
	}
	return false;
}

// Resolve the root's main draft, creating it and stamping
// `@patchwork.mainDraftUrl` the first time.
async function ensureMainDraft(
	repo: Repo,
	root: DocHandle<HasDrafts>,
): Promise<DocHandle<DraftDoc>> {
	const existing = mainDraftUrlOf(root);
	if (existing) return repo.find<DraftDoc>(existing);
	const mainDraft = repo.create<DraftDoc>({
		"@patchwork": { type: "draft" },
		parent: root.url,
		drafts: [],
		clones: {},
	});
	root.change((d: HasDrafts) => {
		// Mutate `@patchwork` in place. Reassigning a spread would carry
		// references to existing Automerge objects into a new object.
		if (!d["@patchwork"]) d["@patchwork"] = {};
		d["@patchwork"]!.mainDraftUrl = mainDraft.url;
	});
	return mainDraft;
}

// The draft to check out instead of `url` after it went away: `url`, or the
// nearest ancestor that hasn't been merged. Null for main.
async function landedOn(
	repo: Repo,
	root: DocHandle<HasDrafts>,
	url: AutomergeUrl | undefined,
): Promise<AutomergeUrl | null> {
	const mainUrl = mainDraftUrlOf(root);
	const seen = new Set<AutomergeUrl>();
	let cursor = url;
	while (cursor && cursor !== mainUrl && !seen.has(cursor)) {
		seen.add(cursor);
		const doc = (await repo.find<DraftDoc>(cursor)).doc();
		if (!doc) return null;
		if (doc.mergedAt === undefined) return cursor;
		cursor = doc.parent;
	}
	return null;
}

function mainDraftUrlOf(root: DocHandle<HasDrafts>): AutomergeUrl | null {
	const url = root.doc()?.["@patchwork"]?.mainDraftUrl;
	return url && isValidAutomergeUrl(url) ? url : null;
}

// "Draft N", counting up on the main draft so numbers stay stable as drafts
// are merged or deleted, skipping any a draft was renamed to.
function nextDefaultName(mainDraft: DocHandle<DraftDoc>, drafts: DraftSummary[]): string {
	const taken = new Set(drafts.map((d) => d.name));
	let name = "";
	while (!name || taken.has(name)) {
		mainDraft.change((d: DraftDoc) => {
			d.draftCounter = (d.draftCounter ?? 0) + 1;
			name = `Draft ${d.draftCounter}`;
		});
	}
	return name;
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
