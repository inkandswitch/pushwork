// Copied from strand's `drafts/src/overlay-types.ts`. Drafts made here and in
// Patchwork share one format, so keep the two in step by hand.
import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";

// An overlay's version of one member. A draft records, when it's forked, the
// version of each member it branches off (`source` at `clonedAt`; `source`
// absent for the member itself) and reads that until its first write clones
// it into `cloneUrl`. A merge records only `cloneUrl`, for a member first
// written while it's looked over, with `clonedAt` the heads it was cloned at.
// A member made while an overlay is checked out is its own clone (`cloneUrl`
// the member itself, `clonedAt` empty).
export type CloneEntry = {
	source?: AutomergeUrl;
	clonedAt: UrlHeads;
	cloneUrl?: AutomergeUrl;
};

type Clones = Record<AutomergeUrl, CloneEntry>;

// On the root: the one pointer to its overlays, written when the first one is
// made.
export type HasOverlays = {
	"@patchwork"?: {
		type?: string;
		overlaysUrl?: AutomergeUrl;
	};
};

// Every overlay of a root.
export type OverlayIndex = {
	"@patchwork": { type: "overlay-index" };
	drafts: AutomergeUrl[];
	merges: AutomergeUrl[];
	// Main's git link, written by `import-git`.
	git?: GitState;
	remote?: GitRemote;
};

export type DraftDoc = {
	"@patchwork": { type: "draft" };
	// Absent: "Draft".
	name?: string;
	// The draft it was forked off; null is main.
	parent: AutomergeUrl | null;
	clones: Clones;
	// The draft's git link, written by `import-git`: it syncs with the branch
	// of its name.
	git?: GitState;
};

// `source` merged into `target`, either of them main (null).
export type MergeDoc = {
	"@patchwork": { type: "merge" };
	source: AutomergeUrl | null;
	target: AutomergeUrl | null;
	clones: Clones;
};

// --- Git sync -----------------------------------------------------------------
// What strand's git sync starts from: main's on the overlay index, a draft's
// on the draft.

// A git commit and the version of the overlay both sides agree it is: the
// heads of every folder and file doc, keyed by original url.
export type SyncPoint = {
	sha: string;
	// the commit's tree, so it needn't be looked up
	tree: string;
	heads: Record<AutomergeUrl, UrlHeads>;
	at: number;
};

export type GitState = {
	// Keyed `${sha}/${random id}`, so two clients recording the same commit
	// both survive the merge.
	syncPoints: Record<string, SyncPoint>;
};

export type GitRemote = { owner: string; repo: string; branch: string };

export const DRAFT_NAME = "Draft";

export function isDraftDoc(value: unknown): value is DraftDoc {
	return markerOf(value) === "draft";
}

export function isMergeDoc(value: unknown): value is MergeDoc {
	return markerOf(value) === "merge";
}

function markerOf(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const marker = (value as { "@patchwork"?: { type?: unknown } })["@patchwork"];
	return typeof marker?.type === "string" ? marker.type : undefined;
}
