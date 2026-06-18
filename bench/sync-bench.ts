/**
 * Offline CPU bench for pushwork's ingest / clone paths.
 *
 * Generates a synthetic tree and runs `init` (or `clone`) against a fully
 * offline Repo (`online:false` ⇒ no sync endpoints), so the measured cost
 * is *pure local work*: change detection, Automerge document creation, text
 * splicing, and snapshot (de)serialization. Network time is deliberately
 * excluded — the timeout/reentrancy behaviour is a separate, server-backed
 * concern. The drift probe in ./profile records how long the event loop is
 * blocked in one unbroken synchronous stretch.
 *
 * Run with tsx (no build step needed):
 *
 *   npx tsx bench/sync-bench.ts --files 2000 --size 512 --text 1 --fanout 20
 *   npx tsx bench/sync-bench.ts --files 5000 --size 256 --text 0   # binary
 *   npx tsx bench/sync-bench.ts --clone-local --files 3000         # pull path
 *   npx tsx bench/sync-bench.ts --clone automerge:... --online      # remote pull
 *
 * Flags:
 *   --files   N    number of files to generate            (default 1000)
 *   --size    N    bytes per file                          (default 512)
 *   --text    R    fraction [0..1] of files that are text  (default 1)
 *   --fanout  N    files per leaf directory                (default 20)
 *   --shape   S    shape to ingest with                    (default vfs)
 *   --backend B    "subduction" | "legacy"                 (default subduction)
 *   --online       sync against the real sync server (default: offline)
 *   --clone   URL  pull an existing remote root into a fresh dir (online)
 *   --clone-local  fully offline clone: ingest a tree in a source dir
 *                  (untimed), copy its storage, then measure the offline pull
 *   --keep         don't delete the temp dir(s) afterwards
 *
 * The profile (event-loop drift, peak RSS) goes to stderr; a one-line JSON
 * summary goes to stdout.
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";

import { clone, heads, init, url, type Backend } from "../src/index.js";
import {
	getProfileReport,
	printProfileReport,
	resetProfile,
	setProfilingEnabled,
	startDriftProbe,
	stopDriftProbe,
} from "./profile.js";

interface Args {
	files: number;
	size: number;
	text: number;
	fanout: number;
	shape: string;
	backend: Backend;
	keep: boolean;
	online: boolean;
	clone: string;
	cloneLocal: boolean;
}

function parseArgs(): Args {
	const a = process.argv.slice(2);
	const get = (flag: string, def: string): string => {
		const i = a.indexOf(flag);
		return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : def;
	};
	return {
		files: parseInt(get("--files", "1000"), 10),
		size: parseInt(get("--size", "512"), 10),
		text: parseFloat(get("--text", "1")),
		fanout: parseInt(get("--fanout", "20"), 10),
		shape: get("--shape", "vfs"),
		backend: get("--backend", "subduction") === "legacy" ? "legacy" : "subduction",
		keep: a.includes("--keep"),
		// --online ⇒ sync against the real sync server (prod). Default is
		// fully offline for a deterministic CPU bench.
		online: a.includes("--online"),
		// --clone <url> ⇒ pull the given root URL into a fresh dir (online),
		// measuring the pull path instead of generating + uploading a tree.
		clone: get("--clone", ""),
		// --clone-local ⇒ fully offline clone: generate + ingest a tree in a
		// source dir (untimed), copy its storage into a fresh dir, then
		// measure the pull-everything clone from local storage. Isolates the
		// clone path's CPU (doc materialization) deterministically.
		cloneLocal: a.includes("--clone-local"),
	};
}

function makeTextContent(seedIdx: number, size: number): string {
	const line =
		`line ${seedIdx} ` + "lorem ipsum dolor sit amet ".repeat(4) + "\n";
	let s = "";
	while (s.length < size) s += line;
	return s.slice(0, size);
}

function makeBinaryContent(seedIdx: number, size: number): Buffer {
	const b = Buffer.allocUnsafe(size);
	for (let i = 0; i < size; i++) b[i] = (seedIdx * 31 + i * 7) & 0xff;
	if (size > 0) b[0] = 0; // NUL ⇒ classified binary
	return b;
}

async function generateTree(root: string, args: Args): Promise<void> {
	for (let f = 0; f < args.files; f++) {
		const d = Math.floor(f / args.fanout);
		const dir = path.join(root, `d${Math.floor(d / 50)}`, `d${d}`);
		await fs.mkdir(dir, { recursive: true });
		const isText = (f % 100) / 100 < args.text;
		if (isText) {
			await fs.writeFile(
				path.join(dir, `f${f}.txt`),
				makeTextContent(f, args.size),
			);
		} else {
			await fs.writeFile(
				path.join(dir, `f${f}.bin`),
				makeBinaryContent(f, args.size),
			);
		}
	}
}

// Count materialized file leaves (every entry except the "/" root folder).
async function countLeaves(dir: string): Promise<number> {
	const entries = await heads(dir);
	return entries.filter((e) => e.path !== "/").length;
}

async function mkTmpRoot(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function main(): Promise<void> {
	const args = parseArgs();
	const cloneMode = args.clone.length > 0;
	const root = await mkTmpRoot("pushwork-bench-");
	const cleanup: string[] = [root];

	try {
		// Generate a tree only when ingesting; clone pulls an existing root.
		let genMs = 0;
		if (!cloneMode && !args.cloneLocal) {
			const genStart = performance.now();
			await generateTree(root, args);
			genMs = Math.round(performance.now() - genStart);
		}

		// --clone-local setup (untimed): ingest the tree in a SOURCE dir, then
		// copy its automerge storage into `root` so the measured clone pulls
		// everything from local storage.
		let localCloneUrl: string | undefined;
		if (args.cloneLocal) {
			const srcRoot = await mkTmpRoot("pushwork-bench-src-");
			cleanup.push(srcRoot);
			await generateTree(srcRoot, args);
			localCloneUrl = (await init({
				dir: srcRoot,
				backend: args.backend,
				shape: args.shape,
				online: false,
			})).url;
			await fs.cp(
				path.join(srcRoot, ".pushwork", "storage"),
				path.join(root, ".pushwork", "storage"),
				{ recursive: true },
			);
		}

		// Print the target URL up front for clone modes so it's grabbable even
		// if the run is interrupted.
		if (cloneMode) process.stderr.write(`ROOT_URL ${args.clone}\n`);
		else if (localCloneUrl) process.stderr.write(`ROOT_URL ${localCloneUrl}\n`);

		setProfilingEnabled(true);
		resetProfile();
		startDriftProbe();
		const syncStart = performance.now();

		if (cloneMode) {
			await clone({
				url: args.clone,
				dir: root,
				backend: args.backend,
				shape: args.shape,
				online: true,
			});
		} else if (args.cloneLocal) {
			await clone({
				url: localCloneUrl!,
				dir: root,
				backend: args.backend,
				shape: args.shape,
				online: false,
			});
		} else {
			await init({
				dir: root,
				backend: args.backend,
				shape: args.shape,
				online: args.online,
			});
		}

		const syncMs = Math.round(performance.now() - syncStart);
		stopDriftProbe();

		const rootUrl = await url(root);
		const filesChanged = await countLeaves(root);

		const mode = cloneMode
			? "clone"
			: args.cloneLocal
				? "clone-local"
				: args.online
					? "online"
					: "offline";
		printProfileReport(
			`${mode} files=${filesChanged} size=${args.size}B text=${args.text}`,
		);

		const summary = {
			config: args,
			mode,
			rootUrl,
			genMs,
			syncMs,
			totalMs: syncMs,
			filesChanged,
			success: true,
			errors: 0,
			...getProfileReport(),
		};
		process.stdout.write(JSON.stringify(summary) + "\n");
	} finally {
		if (!args.keep) {
			for (const dir of cleanup) {
				await fs.rm(dir, { recursive: true, force: true });
			}
		}
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
