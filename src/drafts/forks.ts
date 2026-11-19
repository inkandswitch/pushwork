// Copied from gaios-pkg-base `drafts/src/draft-forks.ts`; keep the two in
// step by hand. Here `forkPoints` takes main's docs from the caller instead
// of walking them with Patchwork's children plugins.
import {
	isValidAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
	type UrlHeads,
} from "@automerge/automerge-repo";
import type { CloneEntry, DraftDoc } from "./types.js";
import { canonicalUrl, cloneAt } from "./clones.js";

// A doc a fork branches off: the parent's clone of it, or the original.
type ForkSource = { url: AutomergeUrl; cloneUrl: AutomergeUrl | null };

// The fork points for a draft forked off `parentUrl` (null = main) as it is
// now, per doc. A doc the parent cloned branches off its clone; one the
// parent only recorded a fork point for keeps that point, since the parent
// never changed it; every other doc of main's (`mainUrls`) branches off the
// original.
export async function forkPoints(
	repo: Repo,
	mainUrls: AutomergeUrl[],
	parentUrl: AutomergeUrl | null,
): Promise<Record<AutomergeUrl, CloneEntry>> {
	const parentClones = parentUrl
		? ((await repo.find<DraftDoc>(parentUrl)).doc()?.clones ?? {})
		: ({} as Record<AutomergeUrl, CloneEntry>);
	const clones: Record<AutomergeUrl, CloneEntry> = {};
	const sources: ForkSource[] = mainUrls
		.filter((url) => !parentClones[url])
		.map((url) => ({ url, cloneUrl: null }));
	for (const [url, entry] of Object.entries(parentClones) as [AutomergeUrl, CloneEntry][]) {
		if (!entry.cloneUrl) clones[url] = forkEntry(url, entry.source, entry.clonedAt);
		else sources.push({ url, cloneUrl: entry.cloneUrl });
	}

	const versions = await currentHeads(repo, sources);
	for (const member of sources) {
		const to = versions.get(member.url);
		if (to) {
			clones[member.url] = forkEntry(member.url, member.cloneUrl, to);
		} else if (member.cloneUrl) {
			const entry = parentClones[member.url];
			clones[member.url] = forkEntry(member.url, entry.source, entry.clonedAt);
		}
	}
	return clones;
}

async function currentHeads(
	repo: Repo,
	members: ForkSource[],
): Promise<Map<AutomergeUrl, UrlHeads>> {
	const heads = new Map<AutomergeUrl, UrlHeads>();
	await Promise.all(
		members.map(async (member) => {
			try {
				const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
				heads.set(member.url, handle.heads());
			} catch {
				// Not available here; the draft reads it live until it forks.
			}
		}),
	);
	return heads;
}

// Automerge rejects `undefined` values, so `source` is only set when the
// draft forks off something other than the doc itself.
function forkEntry(
	url: AutomergeUrl,
	source: AutomergeUrl | null | undefined,
	clonedAt: UrlHeads,
): CloneEntry {
	const from = source ? canonicalUrl(source) : null;
	return from && from !== url ? { source: from, clonedAt } : { clonedAt };
}

// Merges every cloned doc back into the parent draft's copy of it — the
// parent's clone, or the original when the parent never forked the doc —
// recording per-clone merge heads, and marks the draft as merged (which
// hides it from the list). A parent that only recorded a fork point for the
// doc is cloned there first, so the merge lands in the parent rather than
// the original. The merged draft's children are handed up to the merge
// target, so they never dangle under a hidden draft. Returns how many docs
// were merged.
export async function mergeDraft(
	repo: Repo,
	draftHandle: DocHandle<DraftDoc>,
): Promise<number> {
	const doc = draftHandle.doc();
	const parentHandle = await findMergeTarget(repo, doc?.parent);
	const entries = Object.entries(doc?.clones ?? {}) as [AutomergeUrl, CloneEntry][];
	let merged = 0;
	for (const [originalUrl, entry] of entries) {
		if (!entry.cloneUrl) continue;
		const targetUrl = await mergeTargetUrl(repo, parentHandle, originalUrl);
		if (entry.cloneUrl === targetUrl) continue;
		const [target, clone] = await Promise.all([
			repo.find<unknown>(targetUrl),
			repo.find<unknown>(entry.cloneUrl),
		]);
		target.merge(clone);
		merged++;
		const mergedAt = target.heads();
		draftHandle.change((d: DraftDoc) => {
			const e = d.clones[originalUrl];
			if (e) e.mergedAt = mergedAt;
		});
	}
	draftHandle.change((d: DraftDoc) => {
		d.mergedAt = Date.now();
	});

	if (parentHandle) {
		const children = (draftHandle.doc()?.drafts ?? []).filter(isValidAutomergeUrl);
		for (const childUrl of children) {
			const child = await repo.find<DraftDoc>(childUrl);
			child.change((d: DraftDoc) => {
				d.parent = parentHandle.url;
			});
			parentHandle.change((d: DraftDoc) => {
				if (!d.drafts.includes(childUrl)) d.drafts.push(childUrl);
			});
			draftHandle.change((d: DraftDoc) => {
				const i = d.drafts.indexOf(childUrl);
				if (i >= 0) d.drafts.splice(i, 1);
			});
		}
	}
	return merged;
}

// The parent's copy of `url`, cloning it at the parent's fork point when the
// parent hasn't written to it yet.
async function mergeTargetUrl(
	repo: Repo,
	parentHandle: DocHandle<DraftDoc> | null,
	url: AutomergeUrl,
): Promise<AutomergeUrl> {
	const parentEntry = parentHandle?.doc()?.clones?.[url];
	if (!parentHandle || !parentEntry) return url;
	if (parentEntry.cloneUrl) return parentEntry.cloneUrl;
	const source = await repo.find<unknown>(parentEntry.source ?? url);
	const clone = cloneAt(repo, source, parentEntry.clonedAt);
	const cloneUrl = canonicalUrl(clone.url);
	parentHandle.change((d: DraftDoc) => {
		const e = d.clones[url];
		if (e && !e.cloneUrl) e.cloneUrl = cloneUrl;
	});
	return parentHandle.doc()?.clones?.[url]?.cloneUrl ?? cloneUrl;
}

// The draft the merge should land in: the nearest non-merged ancestor,
// ending at the main draft, which is never merged. Null when the chain can't
// be resolved; the merge then lands in the originals.
async function findMergeTarget(
	repo: Repo,
	parentUrl: AutomergeUrl | undefined,
): Promise<DocHandle<DraftDoc> | null> {
	const seen = new Set<AutomergeUrl>();
	let cursor = parentUrl;
	while (cursor && isValidAutomergeUrl(cursor) && !seen.has(cursor)) {
		seen.add(cursor);
		try {
			const candidate = await repo.find<DraftDoc>(cursor);
			if (candidate.doc()?.mergedAt === undefined) return candidate;
			cursor = candidate.doc()?.parent;
		} catch {
			return null;
		}
	}
	return null;
}
