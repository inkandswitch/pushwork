import * as Automerge from "@automerge/automerge";
import {
	interpretAsDocumentId,
	isValidAutomergeUrl,
	parseAutomergeUrl,
	stringifyAutomergeUrl,
	type AnyDocumentId,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
	type UrlHeads,
} from "@automerge/automerge-repo";
import { isDraftDoc, type CloneEntry, type DraftDoc } from "./types.js";
import { canonicalUrl, cloneAt } from "./clones.js";

/**
 * A repo that reads and writes one draft. `find` hands back handles that keep
 * the url they were asked for, so folder links and merge bases name the
 * original docs exactly as Patchwork's drafts do, but read the draft's
 * version of each:
 *
 * - its clone, once the draft has one;
 * - before that, the version the fork recorded (`CloneEntry.clonedAt`);
 * - for a doc the fork didn't record, the live original.
 *
 * The first write to a doc clones it at the version being read and records
 * the clone in `DraftDoc.clones`, so the draft only owns the docs it changed.
 * A doc created through the view is the draft's own: it is recorded as its
 * own clone. A url pinned to heads reads that version of the draft's doc and
 * stays read-only.
 */
export class DraftView {
	readonly repo: Repo;
	readonly draft: DocHandle<DraftDoc>;
	readonly #base: Repo;
	readonly #members = new Map<AutomergeUrl, Promise<Member>>();

	static async open(base: Repo, draftUrl: AutomergeUrl): Promise<DraftView> {
		const draft = await base.find<DraftDoc>(draftUrl);
		if (!isDraftDoc(draft.doc())) throw new Error(`${draftUrl} is not a draft`);
		return new DraftView(base, draft);
	}

	private constructor(base: Repo, draft: DocHandle<DraftDoc>) {
		this.#base = base;
		this.draft = draft;
		this.repo = new Proxy(base, {
			get: (target, prop) => {
				if (prop === "find") return (id: AnyDocumentId) => this.#find(id);
				if (prop === "create") return (value?: unknown) => this.#create(value);
				if (prop === "create2") return async (value?: unknown) => this.#create(value);
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	async #find(id: AnyDocumentId): Promise<DocHandle<unknown>> {
		const url = isValidAutomergeUrl(id)
			? id
			: stringifyAutomergeUrl({ documentId: interpretAsDocumentId(id) });
		const { documentId, heads } = parseAutomergeUrl(url);
		const original = stringifyAutomergeUrl({ documentId });
		if (heads) return this.#findPinned(original, heads);
		let member = this.#members.get(original);
		if (!member) {
			member = this.#open(original);
			member.catch(() => this.#members.delete(original));
			this.#members.set(original, member);
		}
		return (await member).presented;
	}

	async #findPinned(original: AutomergeUrl, heads: UrlHeads): Promise<DocHandle<unknown>> {
		const entry = this.#entry(original);
		const read = entry?.cloneUrl ?? entry?.source ?? original;
		const backing = await this.#base.find<unknown>(withHeads(read, heads));
		return presentAs(withHeads(original, heads), () => backing);
	}

	async #open(original: AutomergeUrl): Promise<Member> {
		const entry = this.#entry(original);
		if (entry?.cloneUrl) {
			return this.#cloned(original, await this.#base.find<unknown>(entry.cloneUrl));
		}
		return this.#forkPoint(original, entry);
	}

	#cloned(original: AutomergeUrl, clone: DocHandle<unknown>): Member {
		const member = { original, backing: clone, clone } as Member;
		member.presented = this.#present(member);
		return member;
	}

	async #forkPoint(original: AutomergeUrl, entry: CloneEntry | undefined): Promise<Member> {
		const source = await this.#base.find<unknown>(entry?.source ?? original);
		const member = {
			original,
			source,
			clonedAt: entry?.clonedAt,
			backing: entry ? source.view(entry.clonedAt) : source,
			clone: null,
		} as Member;
		member.presented = this.#present(member);
		return member;
	}

	#present(member: Member): DocHandle<unknown> {
		return presentAs(member.original, () => member.backing, () => this.#writable(member));
	}

	// Runs inside the write, so the write itself lands on the clone.
	#writable(member: Member): DocHandle<unknown> {
		if (member.clone) return member.clone;
		const source = member.source!;
		const clonedAt = member.clonedAt ?? source.heads();
		const clone = cloneAt(this.#base, source, clonedAt);
		const cloneUrl = canonicalUrl(clone.url);
		this.draft.change((d: DraftDoc) => {
			const entry = d.clones[member.original];
			if (entry) entry.cloneUrl = cloneUrl;
			else d.clones[member.original] = { cloneUrl, clonedAt };
		});
		member.clone = clone;
		member.backing = clone;
		return clone;
	}

	#create(value: unknown): DocHandle<unknown> {
		const handle = this.#base.create<unknown>(value);
		const url = canonicalUrl(handle.url);
		this.draft.change((d: DraftDoc) => {
			d.clones[url] = { cloneUrl: url, clonedAt: [] as unknown as UrlHeads };
		});
		this.#members.set(url, Promise.resolve(this.#cloned(url, handle)));
		return handle;
	}

	#entry(original: AutomergeUrl): CloneEntry | undefined {
		return this.draft.doc()?.clones?.[original];
	}
}

type Member = {
	original: AutomergeUrl;
	// What reads see: the clone, the fork-point snapshot, or the live original.
	backing: DocHandle<unknown>;
	clone: DocHandle<unknown> | null;
	// What a write clones, at `clonedAt` (or where it is now, when unset).
	source?: DocHandle<unknown>;
	clonedAt?: UrlHeads;
	presented: DocHandle<unknown>;
};

const WRITES = new Set<PropertyKey>(["change", "changeAt", "update"]);

const withHeads = (url: AutomergeUrl, heads: UrlHeads): AutomergeUrl =>
	stringifyAutomergeUrl({ documentId: parseAutomergeUrl(url).documentId, heads });

// A handle that answers to `url` but forwards everything to `backing()`,
// sending writes to `writable()` instead.
function presentAs(
	url: AutomergeUrl,
	backing: () => DocHandle<unknown>,
	writable: () => DocHandle<unknown> = backing,
): DocHandle<unknown> {
	return new Proxy(backing(), {
		get(_target, prop) {
			if (prop === "url") return url;
			const target = WRITES.has(prop) ? writable() : backing();
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * Merge away clones that two peers made of the same doc at once. Both write
 * the same `clones` entry, Automerge keeps one, and the other clone's edits
 * would be lost; they are merged into the clone that won instead.
 */
export async function repairCloneConflicts(
	base: Repo,
	draft: DocHandle<DraftDoc>,
): Promise<number> {
	const doc = draft.doc();
	if (!doc?.clones) return 0;
	let repaired = 0;
	for (const original of Object.keys(doc.clones) as AutomergeUrl[]) {
		const losers = losingCloneUrls(doc, original);
		if (losers.length === 0) continue;
		const winnerUrl = draft.doc()?.clones?.[original]?.cloneUrl;
		if (!winnerUrl) {
			draft.change((d: DraftDoc) => {
				d.clones[original].cloneUrl = losers[0];
			});
			repaired++;
			continue;
		}
		const winner = await base.find<unknown>(winnerUrl);
		for (const loserUrl of losers) {
			try {
				winner.merge(await base.find<unknown>(loserUrl));
				repaired++;
			} catch {
				// Not reachable from here; whoever made it can repair it.
			}
		}
	}
	return repaired;
}

function losingCloneUrls(doc: DraftDoc, original: AutomergeUrl): AutomergeUrl[] {
	const winner = doc.clones[original]?.cloneUrl;
	const candidates: unknown[] = [];
	const entries = Automerge.getConflicts(doc.clones as Automerge.Doc<unknown>, original);
	if (entries) for (const e of Object.values(entries)) candidates.push((e as CloneEntry)?.cloneUrl);
	const urls = Automerge.getConflicts(doc.clones[original] as Automerge.Doc<unknown>, "cloneUrl");
	if (urls) candidates.push(...Object.values(urls));
	const losers = new Set<AutomergeUrl>();
	for (const url of candidates) {
		if (typeof url === "string" && isValidAutomergeUrl(url) && url !== winner) losers.add(url);
	}
	return [...losers];
}
