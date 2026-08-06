/**
 * Offline init → clone round-trip used by roundtrip.test.ts.
 *
 * Generates a multi-file tree (text + binary + nested dirs), `init`s it
 * offline, copies the automerge storage into a fresh dir, `clone`s offline
 * from that storage, and byte-compares source vs clone. Exits non-zero
 * (with a printed reason) on any mismatch.
 *
 * Run as a plain-node subprocess against the built dist (Node strips the
 * types): the Subduction Wasm must load as a single consistent instance —
 * the same reason the bench runs compiled rather than under tsx.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clone, init } from "../../../dist/index.js";

const N = Number(process.env.ROUNDTRIP_FIXTURE_FILES) || 40;

function gen(root: string, n: number): void {
	for (let i = 0; i < n; i++) {
		const dir = path.join(root, `d${Math.floor(i / 8)}`, `sub${i % 3}`);
		fs.mkdirSync(dir, { recursive: true });
		const isBinary = i % 5 === 0;
		const body: Buffer | string = isBinary
			? Buffer.from([0, 1, 2, 3, i & 0xff, 254, 255])
			: `file ${i} ` + "lorem ipsum dolor sit amet ".repeat(25) + "\n";
		fs.writeFileSync(path.join(dir, `f${i}.${isBinary ? "bin" : "txt"}`), body);
	}
}

function listFiles(root: string): Map<string, Buffer> {
	const out = new Map<string, Buffer>();
	(function walk(dir: string, rel: string): void {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.name === ".pushwork") continue;
			const full = path.join(dir, e.name);
			const r = rel ? rel + "/" + e.name : e.name;
			if (e.isDirectory()) walk(full, r);
			else out.set(r, fs.readFileSync(full));
		}
	})(root, "");
	return out;
}

async function main(): Promise<void> {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pw-roundtrip-"));
	const src = path.join(base, "src");
	const dst = path.join(base, "dst");
	fs.mkdirSync(src);
	fs.mkdirSync(dst);
	gen(src, N);

	const { url } = await init({ dir: src, backend: "subduction", shape: "vfs", online: false });
	fs.mkdirSync(path.join(dst, ".pushwork"), { recursive: true });
	fs.cpSync(
		path.join(src, ".pushwork", "storage.lmdb"),
		path.join(dst, ".pushwork", "storage.lmdb"),
	);
	await clone({ url, dir: dst, backend: "subduction", shape: "vfs", online: false });

	const a = listFiles(src);
	const b = listFiles(dst);
	const problems: string[] = [];
	if (a.size !== N) problems.push(`source has ${a.size} files, expected ${N}`);
	if (a.size !== b.size) problems.push(`clone has ${b.size} files, expected ${a.size}`);
	for (const [rel, bytesA] of a) {
		const bytesB = b.get(rel);
		if (!bytesB) problems.push(`missing in clone: ${rel}`);
		else if (!bytesA.equals(bytesB)) problems.push(`content differs: ${rel}`);
	}

	fs.rmSync(base, { recursive: true, force: true });
	if (problems.length > 0) {
		console.error("round-trip FAILED:\n  " + problems.join("\n  "));
		process.exit(1);
	}
	console.log(`round-trip OK: ${a.size} files byte-identical`);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
