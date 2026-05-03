import * as fs from "fs/promises";
import * as path from "path";
import { isValidAutomergeUrl, type AutomergeUrl } from "@automerge/automerge-repo";
import {
	configExists,
	pushworkDir,
	readConfig,
	readHeads,
	storageDir,
	writeConfig,
	writeHeads,
	type Backend,
} from "./config.js";
import { loadIgnore } from "./ignore.js";
import { byteEq, materialize, walkDir, type FileTree } from "./fs-tree.js";
import { openRepo, waitForSync } from "./repo.js";

export type RootDoc = {
	files: { [path: string]: Uint8Array };
};

const empty = (): RootDoc => ({ files: {} });

async function dirIsEmpty(dir: string): Promise<boolean> {
	try {
		const entries = await fs.readdir(dir);
		return entries.length === 0;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw err;
	}
}

export async function init(opts: {
	dir: string;
	backend: Backend;
}): Promise<AutomergeUrl> {
	const root = path.resolve(opts.dir);
	if (await configExists(root)) {
		throw new Error(`pushwork already initialized at ${root}`);
	}
	await fs.mkdir(pushworkDir(root), { recursive: true });

	const repo = await openRepo(opts.backend, storageDir(root));
	try {
		const ig = await loadIgnore(root);
		const tree = await walkDir(root, ig);

		const initial = empty();
		for (const [p, bytes] of tree) initial.files[p] = bytes;

		const handle = repo.create<RootDoc>(initial);
		await handle.whenReady();
		await waitForSync(handle, { idleMs: 1500, maxMs: 8000 });

		await writeConfig(root, { rootUrl: handle.url, backend: opts.backend });
		await writeHeads(root, handle.heads());
		return handle.url;
	} finally {
		await repo.shutdown();
	}
}

export async function clone(opts: {
	url: string;
	dir: string;
	backend: Backend;
}): Promise<void> {
	if (!isValidAutomergeUrl(opts.url)) {
		throw new Error(`invalid automerge URL: ${opts.url}`);
	}
	const root = path.resolve(opts.dir);
	await fs.mkdir(root, { recursive: true });
	if (await configExists(root)) {
		throw new Error(`pushwork already initialized at ${root}`);
	}
	if (!(await dirIsEmpty(root))) {
		// allow non-empty if no .pushwork — we just refuse to clobber existing files later
	}
	await fs.mkdir(pushworkDir(root), { recursive: true });
	await writeConfig(root, {
		rootUrl: opts.url as AutomergeUrl,
		backend: opts.backend,
	});

	const repo = await openRepo(opts.backend, storageDir(root));
	try {
		const handle = await repo.find<RootDoc>(opts.url as AutomergeUrl);
		await waitForSync(handle, { idleMs: 1500, maxMs: 15000 });

		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);
		await materialize(root, handle.doc().files, fsFiles);
		await writeHeads(root, handle.heads());
	} finally {
		await repo.shutdown();
	}
}

export async function url(cwd: string): Promise<AutomergeUrl> {
	const config = await readConfig(path.resolve(cwd));
	return config.rootUrl;
}

export async function sync(cwd: string): Promise<void> {
	const root = path.resolve(cwd);
	const config = await readConfig(root);
	const savedHeads = await readHeads(root);

	const repo = await openRepo(config.backend, storageDir(root));
	try {
		const handle = await repo.find<RootDoc>(config.rootUrl);

		const ig = await loadIgnore(root);
		const fsFiles = await walkDir(root, ig);

		const oldFiles: Record<string, Uint8Array> = savedHeads
			? { ...handle.view(savedHeads).doc().files }
			: {};

		applyLocalChanges(handle, oldFiles, fsFiles);

		await waitForSync(handle, { idleMs: 1500, maxMs: 15000 });

		const finalDoc = handle.doc();
		await materialize(root, finalDoc.files, fsFiles);
		await writeHeads(root, handle.heads());
	} finally {
		await repo.shutdown();
	}
}

function applyLocalChanges(
	handle: { change: (fn: (d: RootDoc) => void) => void },
	oldFiles: Record<string, Uint8Array>,
	fsFiles: FileTree,
): void {
	const adds: Array<[string, Uint8Array]> = [];
	const dels: string[] = [];
	for (const [p, bytes] of fsFiles) {
		const old = oldFiles[p];
		const oldView = old ? new Uint8Array(old) : undefined;
		if (!byteEq(oldView, bytes)) adds.push([p, bytes]);
	}
	for (const p of Object.keys(oldFiles)) {
		if (!fsFiles.has(p)) dels.push(p);
	}
	if (adds.length === 0 && dels.length === 0) return;
	handle.change((d) => {
		for (const [p, bytes] of adds) d.files[p] = bytes;
		for (const p of dels) delete d.files[p];
	});
}
