/**
 * Offline bench for pushwork's *incremental* paths — the ones you hit on every
 * command after the first: `status`, `diff`, and `save` over a tree that has
 * barely moved.
 *
 * `sync-bench.ts` measures ingest and pull, where all the work is genuinely
 * new. This measures the repeat cost: walking the working tree, decoding file
 * documents, and comparing the two.
 *
 * Uses only the public API (`init`, `status`, `diff`, `save`), so the same
 * file runs against any revision of the library.
 *
 *   npx tsx bench/incremental-bench.ts --files 2000 --size 512
 *
 * Flags:
 *   --files   N    number of files to generate            (default 1000)
 *   --size    N    bytes per file                          (default 512)
 *   --fanout  N    files per leaf directory                (default 20)
 *   --touch   N    files to modify before the save phase   (default 1)
 *   --shape   S    shape to ingest with                    (default vfs)
 *   --keep         don't delete the temp dir afterwards
 *
 * A one-line JSON summary goes to stdout; a readable table to stderr.
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";

import { diff, init, save, status } from "../src/index.js";

interface Args {
	files: number;
	size: number;
	fanout: number;
	touch: number;
	shape: string;
	keep: boolean;
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
		fanout: parseInt(get("--fanout", "20"), 10),
		touch: parseInt(get("--touch", "1"), 10),
		shape: get("--shape", "vfs"),
		keep: a.includes("--keep"),
	};
}

const content = (seed: number, size: number): string => {
	const line = `line ${seed} ` + "lorem ipsum dolor sit amet ".repeat(4) + "\n";
	let s = "";
	while (s.length < size) s += line;
	return s.slice(0, size);
};

const filePath = (root: string, f: number, fanout: number): string => {
	const d = Math.floor(f / fanout);
	return path.join(root, `d${Math.floor(d / 50)}`, `d${d}`, `f${f}.txt`);
};

async function generateTree(root: string, args: Args): Promise<void> {
	for (let f = 0; f < args.files; f++) {
		const target = filePath(root, f, args.fanout);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, content(f, args.size));
	}
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
	const start = performance.now();
	const value = await fn();
	return [value, Math.round(performance.now() - start)];
}

async function main(): Promise<void> {
	const args = parseArgs();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-incr-"));

	try {
		await generateTree(root, args);

		const phases: Record<string, number> = {};
		[, phases.init] = await timed(() =>
			init({ dir: root, backend: "subduction", shape: args.shape, online: false }),
		);

		// First status after init: nothing is warm yet on either revision.
		[, phases.statusCold] = await timed(() => status(root));
		// Repeat runs over an unchanged tree — the common case.
		[, phases.statusWarm] = await timed(() => status(root));
		[, phases.statusWarm2] = await timed(() => status(root));
		[, phases.diffClean] = await timed(() => diff(root));

		for (let i = 0; i < args.touch; i++) {
			const f = Math.floor((i * args.files) / Math.max(1, args.touch));
			await fs.writeFile(
				filePath(root, f, args.fanout),
				content(f, args.size) + "touched\n",
			);
		}

		[, phases.statusDirty] = await timed(() => status(root));
		[, phases.save] = await timed(() => save(root));
		[, phases.statusAfterSave] = await timed(() => status(root));

		const width = Math.max(...Object.keys(phases).map((k) => k.length));
		process.stderr.write(
			`\nfiles=${args.files} size=${args.size}B touched=${args.touch}\n` +
				Object.entries(phases)
					.map(([k, v]) => `  ${k.padEnd(width)}  ${String(v).padStart(7)} ms`)
					.join("\n") +
				"\n",
		);
		process.stdout.write(JSON.stringify({ config: args, phases }) + "\n");
	} finally {
		if (!args.keep) await fs.rm(root, { recursive: true, force: true });
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
