// Copied from gaios-pkg-base `drafts/src/draft-types.ts`. Drafts made here and
// in Patchwork share one format, so keep the two in step by hand.
import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";

// A draft's version of one doc. Forking records where the draft branches
// off — `source` (the parent draft's clone; absent for the original) at
// `clonedAt` — and the draft reads that snapshot until its first write
// clones it there into `cloneUrl`. A doc created on the draft is its own
// clone (`cloneUrl` the doc itself, `clonedAt` empty). `mergedAt` is the
// target's heads after the clone merged back.
export type CloneEntry = {
	source?: AutomergeUrl;
	clonedAt: UrlHeads;
	cloneUrl?: AutomergeUrl;
	mergedAt?: UrlHeads;
};

// `parent` is what this draft branches off: the main draft for a top-level
// draft, another `DraftDoc` for a sub-draft. The main draft is the one the
// root's `@patchwork.mainDraftUrl` points at; it is bookkeeping only, never
// read through, its `drafts` holds the top-level drafts, and its `parent` is
// the root itself.
//
// `mergedAt` is a wall-clock timestamp set when the draft is merged into its
// parent; absent means "still open". Merged drafts drop out of the list.
//
// `name` is the user-given display name; absent means the default label.
export type DraftDoc = {
	"@patchwork": { type: "draft" };
	name?: string;
	parent: AutomergeUrl;
	drafts: AutomergeUrl[];
	clones: Record<AutomergeUrl, CloneEntry>;
	mergedAt?: number;
	// Main draft only: monotonic counter behind new drafts' default names
	// ("Draft N"). Never decremented, so numbers aren't reused after deletes.
	draftCounter?: number;
};

// A root that has been drafted carries `@patchwork.mainDraftUrl`. The first
// fork creates it.
export type HasDrafts = {
	"@patchwork"?: {
		type?: string;
		mainDraftUrl?: AutomergeUrl;
	};
};

export function isDraftDoc(value: unknown): value is DraftDoc {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	const marker = v["@patchwork"] as { type?: string } | undefined;
	return marker?.type === "draft" && !!v.clones && typeof v.clones === "object";
}
