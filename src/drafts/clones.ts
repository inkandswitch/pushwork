// Copied from strand's `drafts/src/draft-clones.ts` and `children.ts`; keep
// the two in step by hand.
import * as Automerge from "@automerge/automerge";
import {
	decodeHeads,
	parseAutomergeUrl,
	stringifyAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
	type UrlHeads,
} from "@automerge/automerge-repo";

// Reduce a url to its bare document identity by stripping any path/heads
// suffix, so urls arriving from different traversals dedupe to the same key.
export function canonicalUrl(url: AutomergeUrl): AutomergeUrl {
	const { documentId } = parseAutomergeUrl(url);
	return stringifyAutomergeUrl({ documentId });
}

// Clone `handle`'s doc as of `to`. When `to` is where the doc already is,
// that's a plain clone.
export function cloneAt(
	repo: Repo,
	handle: DocHandle<unknown>,
	to: UrlHeads,
): DocHandle<unknown> {
	if (sameHeads(handle.heads(), to)) return repo.clone(handle);
	if (to.length === 0) return repo.create<unknown>();
	return cloneAtVersion(repo, handle, to);
}

// The obvious way — `repo.clone(handle.view(to))`, i.e. wasm `fork_at` — is
// broken upstream: on documents whose history contains certain concurrent
// merge changes (as anything synced through subduction ends up with),
// `fork_at` panics with `MissingOps` at any heads, and the panic poisons the
// doc for the rest of the session.
//
// So the version clone is built without `fork_at`: collect the ancestor
// closure of the pin heads from the change metadata, bundle exactly those
// changes, hydrate a fresh doc from the bundle, and install it into a new
// repo handle. The resulting doc's heads are exactly `to`, it shares history
// with the original, and merges back cleanly. Throws (a plain JS error, no
// wasm panic) when the pin's ancestry can't be resolved.
export function cloneAtVersion(
	repo: Repo,
	handle: DocHandle<unknown>,
	to: UrlHeads,
): DocHandle<unknown> {
	const doc = handle.doc() as Automerge.Doc<unknown>;
	const pinHeads = decodeHeads(to);

	const metas = Automerge.getChangesMetaSince(doc, []);
	const byHash = new Map(metas.map((m) => [m.hash, m]));
	const closure = new Set<string>();
	const stack = [...pinHeads];
	while (stack.length > 0) {
		const hash = stack.pop()!;
		if (closure.has(hash)) continue;
		const meta = byHash.get(hash);
		if (!meta) {
			throw new Error(`[drafts] change ${hash} is not in the doc's history metadata`);
		}
		closure.add(hash);
		stack.push(...meta.deps);
	}

	const bundle = Automerge.saveBundle(doc, [...closure]);
	const pinned = Automerge.loadIncremental(Automerge.init<unknown>(), bundle);

	const gotHeads = [...Automerge.getHeads(pinned)].sort();
	const wantHeads = [...pinHeads].sort();
	if (JSON.stringify(gotHeads) !== JSON.stringify(wantHeads)) {
		throw new Error(
			`[drafts] version clone heads mismatch: wanted ${wantHeads}, got ${gotHeads}`,
		);
	}

	const clone = repo.create<unknown>();
	clone.update(() => pinned);
	return clone;
}

function sameHeads(a: UrlHeads, b: UrlHeads): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(b);
	return a.every((h) => set.has(h));
}
