// Copied from strand's `drafts/src/overlay-actions.ts`; keep the two in step
// by hand. Here `forkPoints` takes main's docs from the caller instead of
// walking them with Patchwork's children plugins.
import type { AutomergeUrl, DocHandle, Repo, UrlHeads } from "@automerge/automerge-repo";
import type { CloneEntry, DraftDoc } from "./types.js";
import { canonicalUrl, cloneAt } from "./clones.js";

// The forks of a draft off `parentUrl` (null for main), per doc. A doc the
// parent cloned branches off its clone as it is now; one the parent only
// recorded a fork point for keeps that point, since the parent never changed
// it; every other doc of main's (`mainUrls`) branches off the doc as it is
// now.
export async function forkPoints(
	repo: Repo,
	mainUrls: AutomergeUrl[],
	parentUrl: AutomergeUrl | null,
): Promise<Record<AutomergeUrl, CloneEntry>> {
	const parentClones = parentUrl
		? ((await repo.find<DraftDoc>(parentUrl)).doc()?.clones ?? {})
		: ({} as Record<AutomergeUrl, CloneEntry>);
	const clones: Record<AutomergeUrl, CloneEntry> = {};
	const sources = mainUrls
		.filter((url) => !parentClones[url])
		.map((url) => ({ url, read: url }));
	for (const [url, entry] of Object.entries(parentClones) as [AutomergeUrl, CloneEntry][]) {
		if (entry.cloneUrl) sources.push({ url, read: entry.cloneUrl });
		else clones[url] = forkEntry(url, entry.source, entry.clonedAt);
	}
	await Promise.all(
		sources.map(async ({ url, read }) => {
			try {
				const handle = await repo.find<unknown>(read);
				clones[url] = forkEntry(url, read, handle.heads());
			} catch {
				// Not available here; the draft reads it live until it's written.
			}
		}),
	);
	return clones;
}

// Automerge rejects `undefined` values, so `source` is only set when the
// draft forks off something other than the doc itself.
function forkEntry(
	url: AutomergeUrl,
	source: AutomergeUrl | undefined,
	clonedAt: UrlHeads,
): CloneEntry {
	const from = source ? canonicalUrl(source) : null;
	const heads = [...clonedAt] as UrlHeads;
	return from && from !== url ? { source: from, clonedAt: heads } : { clonedAt: heads };
}

// Where a merge into `draft` (null for main) writes `url`: main's doc itself,
// the draft's clone, or a clone made now of the version the draft reads, so
// nothing outside the draft is written.
export async function writableCopy(
	repo: Repo,
	draft: DocHandle<DraftDoc> | null,
	url: AutomergeUrl,
): Promise<DocHandle<unknown>> {
	if (!draft) return repo.find<unknown>(url);
	const entry = draft.doc()?.clones?.[url];
	if (entry?.cloneUrl) return repo.find<unknown>(entry.cloneUrl);
	const source = await repo.find<unknown>(entry?.source ?? url);
	const clonedAt = entry ? ([...entry.clonedAt] as UrlHeads) : source.heads();
	const clone = cloneAt(repo, source, clonedAt);
	const cloneUrl = canonicalUrl(clone.url);
	draft.change((d: DraftDoc) => {
		const recorded = d.clones[url];
		if (recorded) recorded.cloneUrl = cloneUrl;
		else d.clones[url] = { clonedAt, cloneUrl };
	});
	return clone;
}
