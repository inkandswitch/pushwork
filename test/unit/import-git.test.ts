/**
 * White-box tests for `import-git`: build a git repo, import it offline, and
 * read the stored workspace back the way strand's drafts do.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execFileSync } from "child_process";
import {
	initSubduction,
	isValidAutomergeUrl,
	Repo as RepoCtor,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
} from "@automerge/automerge-repo";
import { LMDBStorageAdapter } from "@automerge/automerge-repo-storage-lmdb";

import { importGit } from "../../src/import-git.js";
import { stripHeads } from "../../src/index.js";
import type { CloneEntry, DraftDoc, OverlayIndex } from "../../src/drafts/types.js";

type FolderDoc = {
	"@patchwork": { type: string; overlaysUrl?: AutomergeUrl };
	docs: { name: string; type: string; url: AutomergeUrl }[];
};

async function withRepo<T>(storage: string, fn: (repo: Repo) => Promise<T>): Promise<T> {
	await initSubduction();
	const repo = new RepoCtor({ storage: new LMDBStorageAdapter(`${storage}.lmdb`), network: [] });
	try {
		return await fn(repo);
	} finally {
		await repo.shutdown();
	}
}

// The files a draft (or main, with no clones) sees, as text.
async function filesOf(
	repo: Repo,
	root: AutomergeUrl,
	clones: Record<AutomergeUrl, CloneEntry> = {},
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const read = async (url: AutomergeUrl) => {
		const entry = clones[url];
		if (entry?.cloneUrl) return (await repo.find<unknown>(entry.cloneUrl)).doc();
		const handle = await repo.find<unknown>(entry?.source ?? url);
		return entry ? handle.view(entry.clonedAt).doc() : handle.doc();
	};
	const walk = async (url: AutomergeUrl, dir: string) => {
		const folder = (await read(url)) as FolderDoc;
		for (const link of folder.docs) {
			const p = dir ? `${dir}/${link.name}` : link.name;
			if (link.type === "folder") await walk(stripHeads(link.url), p);
			else {
				const doc = (await read(stripHeads(link.url))) as { content: unknown };
				out[p] = String(doc.content);
			}
		}
	};
	await walk(root, "");
	return out;
}

describe("import-git", () => {
	let work: string;
	let cleanup: () => void;
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: path.join(work, "repo"),
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
		})
			.toString()
			.trim();
	const write = (file: string, content: string) =>
		fs
			.mkdir(path.dirname(path.join(work, "repo", file)), { recursive: true })
			.then(() => fs.writeFile(path.join(work, "repo", file), content));
	const commit = async (files: Record<string, string | null>, message: string) => {
		for (const [file, content] of Object.entries(files)) {
			if (content === null) git("rm", "-q", file);
			else await write(file, content);
		}
		git("add", "-A");
		git("commit", "-q", "-m", message);
		return git("rev-parse", "HEAD");
	};

	beforeEach(async () => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		work = t.name;
		cleanup = t.removeCallback;
		await fs.mkdir(path.join(work, "repo"));
		git("init", "-q", "-b", "main");
		git("remote", "add", "origin", "git@github.com:ink/demo.git");
	});

	afterEach(() => cleanup());

	it("makes main from the default branch and a draft of each other branch", async () => {
		const first = await commit({ "README.md": "hello\n", "src/a.ts": "one\ntwo\n" }, "first");
		// a branch from the first commit, then main moves on
		git("checkout", "-q", "-b", "feature");
		const featureTip = await commit(
			{ "src/a.ts": "one\nTWO\n", "src/new/b.ts": "bee\n", "README.md": null },
			"feature work",
		);
		git("checkout", "-q", "main");
		const second = await commit({ "src/c.ts": "see\n" }, "second");
		// a branch already merged into main
		git("branch", "merged", first);

		const storage = path.join(work, "storage");
		const info = await importGit({
			gitDir: path.join(work, "repo"),
			backend: "subduction",
			online: false,
			storageDir: storage,
		});

		expect(info.main).toEqual({ branch: "main", commits: 2, files: 3 });
		expect(info.drafts.map((d) => d.branch)).toEqual(["feature"]);
		expect(info.skipped).toEqual([{ branch: "merged", reason: "already merged into main" }]);
		expect(info.github).toEqual({ owner: "ink", repo: "demo" });

		await withRepo(storage, async (repo) => {
			const root = await repo.find<FolderDoc>(info.url);
			expect(root.doc()["@patchwork"].overlaysUrl).toBe(info.index);
			expect(await filesOf(repo, info.url)).toEqual({
				"README.md": "hello\n",
				"src/a.ts": "one\ntwo\n",
				"src/c.ts": "see\n",
			});

			const main = (await repo.find<OverlayIndex>(info.index)).doc();
			expect(main["@patchwork"]).toEqual({ type: "overlay-index" });
			expect(main.merges).toEqual([]);
			expect(main.remote).toEqual({ owner: "ink", repo: "demo", branch: "main" });
			const points = Object.values(main.git!.syncPoints).sort((a, b) => a.at - b.at);
			expect(points.map((p) => p.sha)).toEqual([first, second]);
			expect(points[1].heads[info.url]).toEqual(root.heads());

			const draftUrl = info.drafts[0].url;
			expect(main.drafts).toEqual([draftUrl]);
			const draft = (await repo.find<DraftDoc>(draftUrl)).doc();
			expect(draft.name).toBe("feature");
			expect(draft.parent).toBeNull();
			// copied from main at the first commit: no c.ts, the branch's edits
			expect(await filesOf(repo, info.url, draft.clones)).toEqual({
				"src/a.ts": "one\nTWO\n",
				"src/new/b.ts": "bee\n",
			});
			const [point] = Object.values(draft.git!.syncPoints);
			expect(point.sha).toBe(featureTip);
			// every doc's fork point is main's first sync point
			for (const [url, entry] of Object.entries(draft.clones)) {
				if (entry.clonedAt.length) expect(entry.clonedAt).toEqual(points[0].heads[url]);
			}
			// drafts never write into main's docs
			for (const url of Object.keys(draft.clones)) expect(isValidAutomergeUrl(url)).toBe(true);
		});
	});

	it("replays only from the oldest commit a draft starts at, or all of it with history", async () => {
		await commit({ "a.txt": "1\n" }, "one");
		await commit({ "a.txt": "2\n" }, "two");
		await commit({ "a.txt": "3\n" }, "three");

		const tipOnly = await importGit({
			gitDir: path.join(work, "repo"),
			backend: "subduction",
			online: false,
			storageDir: path.join(work, "s1"),
			github: null,
		});
		expect(tipOnly.main.commits).toBe(1);
		expect(tipOnly.github).toBeUndefined();

		const all = await importGit({
			gitDir: path.join(work, "repo"),
			backend: "subduction",
			online: false,
			storageDir: path.join(work, "s2"),
			history: true,
			depth: 2,
		});
		expect(all.main.commits).toBe(2);
	});

	it("skips a branch that started further back than the depth", async () => {
		await commit({ "a.txt": "1\n" }, "one");
		git("branch", "old");
		git("checkout", "-q", "old");
		await commit({ "b.txt": "b\n" }, "old work");
		git("checkout", "-q", "main");
		await commit({ "a.txt": "2\n" }, "two");
		await commit({ "a.txt": "3\n" }, "three");

		const info = await importGit({
			gitDir: path.join(work, "repo"),
			backend: "subduction",
			online: false,
			storageDir: path.join(work, "s"),
			depth: 2,
		});
		expect(info.drafts).toEqual([]);
		expect(info.skipped[0]).toMatchObject({ branch: "old", reason: expect.stringMatching(/--depth/) });
	});
	it("stores files a datatype rule covers as JSON documents, on main and in drafts", async () => {
		await commit(
			{
				".pushworkattributes": "*.nb  datatype=notebook  strip-metadata\n",
				"a.nb": JSON.stringify({ cells: ["one"] }) + "\n",
				"b.txt": "bee\n",
			},
			"first",
		);
		git("checkout", "-q", "-b", "nb-work");
		const tip = await commit({ "a.nb": JSON.stringify({ cells: ["one", "two"] }) + "\n" }, "more cells");
		git("checkout", "-q", "main");

		const storage = path.join(work, "storage");
		const info = await importGit({
			gitDir: path.join(work, "repo"),
			backend: "subduction",
			online: false,
			storageDir: storage,
		});

		await withRepo(storage, async (repo) => {
			const docAt = async (folder: AutomergeUrl, name: string, clones: Record<AutomergeUrl, CloneEntry> = {}) => {
				const read = async (url: AutomergeUrl) => {
					const entry = clones[url];
					if (entry?.cloneUrl) return (await repo.find<any>(entry.cloneUrl)).doc();
					const handle = await repo.find<any>(url);
					return entry ? handle.view(entry.clonedAt).doc() : handle.doc();
				};
				const link = ((await read(folder)) as FolderDoc).docs.find((l) => l.name === name)!;
				return read(stripHeads(link.url));
			};
			const onMain = await docAt(info.url, "a.nb");
			expect(onMain["@patchwork"].type).toBe("notebook");
			expect(onMain.cells).toEqual(["one"]);

			const draft = (await repo.find<DraftDoc>(info.drafts[0].url)).doc();
			const onDraft = await docAt(info.url, "a.nb", draft.clones);
			expect(onDraft["@patchwork"].type).toBe("notebook");
			expect(onDraft.cells).toEqual(["one", "two"]);
			expect(Object.values(draft.git!.syncPoints)[0].sha).toBe(tip);
			// the notebook's document is in the sync points, as strand's git sync reads it
			const main = (await repo.find<OverlayIndex>(info.index)).doc();
			const mainPoint = Object.values(main.git!.syncPoints)[0];
			const root = (await repo.find<FolderDoc>(info.url)).doc();
			const nb = stripHeads(root.docs.find((l) => l.name === "a.nb")!.url);
			expect(mainPoint.heads[nb]).toBeDefined();
			expect(Object.values(draft.git!.syncPoints)[0].heads[nb]).toBeDefined();
			// main's copy is untouched
			expect((await docAt(info.url, "a.nb")).cells).toEqual(["one"]);
		});
	});
});
