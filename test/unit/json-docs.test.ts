/**
 * White-box tests for JSON documents in a working tree: `.json` files whose
 * `@patchwork.type` isn't "file" are stored as Automerge objects when the
 * repo's `jsonDocuments` flag is on. All tests run fully offline.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import {
	initSubduction,
	parseAutomergeUrl,
	Repo as RepoCtor,
	type AutomergeUrl,
	type Repo,
} from "@automerge/automerge-repo";
import { LMDBStorageAdapter } from "@automerge/automerge-repo-storage-lmdb";

import {
	init,
	save,
	status,
	nuclearizeRepo,
	stripHeads,
	type UnixFileEntry,
} from "../../src/index.js";
import { readConfig, writeConfig } from "../../src/config.js";
import { jsonValueOf, type JsonObject } from "../../src/shapes/json.js";

const MODEL = {
	"@patchwork": { type: "stock-flow-model" },
	title: "Housing",
	variables: {
		students: { label: "Students", initial: 100 },
		rent: { label: "Rent", initial: 8 },
	},
};

/** Written the way a script would: one-space indent, insertion key order —
 * neither of which Automerge keeps. */
const modelText = (value: object = MODEL) => JSON.stringify(value, null, 1) + "\n";

async function withRepo<T>(
	workRoot: string,
	fn: (repo: Repo) => Promise<T>,
): Promise<T> {
	await initSubduction();
	const storage = path.join(workRoot, ".pushwork", "storage.lmdb");
	const repo = new RepoCtor({ storage: new LMDBStorageAdapter(storage), network: [] });
	try {
		return await fn(repo);
	} finally {
		await repo.shutdown();
	}
}

describe("JSON documents", () => {
	let workRoot: string;
	let cleanup: () => void;

	beforeEach(() => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		workRoot = t.name;
		cleanup = t.removeCallback;
	});

	afterEach(() => cleanup());

	const modelPath = () => path.join(workRoot, "model.json");

	async function setup(jsonDocuments: boolean, shape = "vfs"): Promise<void> {
		await fs.writeFile(modelPath(), modelText());
		await fs.writeFile(path.join(workRoot, "package.json"), '{"name":"x"}\n');
		await init({
			dir: workRoot,
			backend: "subduction",
			shape,
			online: false,
			jsonDocuments,
		});
	}

	/** The pinned link a vfs folder doc holds for `name`. */
	async function linkOf(name: string): Promise<AutomergeUrl> {
		const cfg = await readConfig(workRoot);
		return withRepo(workRoot, async (repo) => {
			const folder = await repo.find<Record<string, unknown>>(cfg.rootUrl);
			return folder.doc()[name] as AutomergeUrl;
		});
	}

	async function docAt(name: string): Promise<unknown> {
		const url = stripHeads(await linkOf(name));
		return withRepo(workRoot, async (repo) => (await repo.find(url)).doc());
	}

	it("stores a qualifying file as an object and leaves the disk copy alone", async () => {
		await setup(true);

		expect(await docAt("model.json")).toEqual(MODEL);
		expect(((await docAt("package.json")) as UnixFileEntry).content).toBe(
			'{"name":"x"}\n',
		);
		expect((await status(workRoot)).diff).toEqual({
			added: [],
			modified: [],
			deleted: [],
		});
		await save(workRoot);
		expect(await fs.readFile(modelPath(), "utf8")).toBe(modelText());
	});

	it("keeps .json files as text without the flag", async () => {
		await setup(false);
		expect(((await docAt("model.json")) as UnixFileEntry).content).toBe(
			modelText(),
		);
	});

	it("links a JSON document in a Patchwork folder by its own type", async () => {
		await setup(true, "patchwork-folder");
		const cfg = await readConfig(workRoot);
		const links = await withRepo(workRoot, async (repo) => {
			const folder = await repo.find<{ docs: { name: string; type: string }[] }>(
				cfg.rootUrl,
			);
			return folder.doc().docs;
		});
		const typeOf = (name: string) => links.find((l) => l.name === name)?.type;
		expect(typeOf("model.json")).toBe("stock-flow-model");
		expect(typeOf("package.json")).toBe("json");
	});

	it("converts a file tracked as text once the flag is turned on", async () => {
		await setup(false);
		const before = parseAutomergeUrl(await linkOf("model.json")).documentId;

		await writeConfig(workRoot, { ...(await readConfig(workRoot)), jsonDocuments: true });
		await save(workRoot);

		expect(parseAutomergeUrl(await linkOf("model.json")).documentId).not.toBe(before);
		expect(await docAt("model.json")).toEqual(MODEL);
		expect(await fs.readFile(modelPath(), "utf8")).toBe(modelText());
	});

	it("merges a doc edit with a concurrent disk edit, keeping the file's layout", async () => {
		await setup(true);
		const url = stripHeads(await linkOf("model.json"));
		await withRepo(workRoot, async (repo) => {
			const handle = await repo.find<typeof MODEL>(url);
			handle.change((d) => {
				d.variables.rent.initial = 9;
			});
		});
		const diskEdit = structuredClone(MODEL);
		diskEdit.variables.students.label = "Students (RWTH)";
		await fs.writeFile(modelPath(), modelText(diskEdit));

		await save(workRoot);

		const merged = structuredClone(diskEdit);
		merged.variables.rent.initial = 9;
		expect(await docAt("model.json")).toEqual(merged);
		expect(await fs.readFile(modelPath(), "utf8")).toBe(modelText(merged));
	});

	it("holds a document whose file stops parsing, then resumes", async () => {
		await setup(true);
		const pin = await linkOf("model.json");
		await fs.writeFile(modelPath(), '{ "title": ');

		const warnings: string[] = [];
		await save(workRoot, undefined, (m) => warnings.push(m));

		expect(warnings.some((w) => w.includes("model.json"))).toBe(true);
		expect(await linkOf("model.json")).toBe(pin);
		expect(await fs.readFile(modelPath(), "utf8")).toBe('{ "title": ');

		await fs.writeFile(modelPath(), modelText({ ...MODEL, title: "Fixed" }));
		await save(workRoot);
		expect(((await docAt("model.json")) as JsonObject).title).toBe("Fixed");
	});

	it("nuclearize recreates a JSON document as a JSON document", async () => {
		await setup(true);
		const before = await linkOf("model.json");
		await nuclearizeRepo(workRoot);
		const after = await linkOf("model.json");
		expect(parseAutomergeUrl(after).documentId).not.toBe(
			parseAutomergeUrl(before).documentId,
		);
		expect(jsonValueOf(await docAt("model.json"))).toEqual(
			jsonValueOf(MODEL),
		);
	});
});
