// init → clone through the test server reproduces a multi-file tree byte for byte.
import * as fs from "fs";
import * as path from "path";
import * as tmp from "tmp";
import { inject } from "vitest";
import { clone, init } from "../../src/index.js";
import { userFiles } from "../cli";

const N = 40;

function generate(root: string) {
	for (let i = 0; i < N; i++) {
		const dir = path.join(root, `d${Math.floor(i / 8)}`, `sub${i % 3}`);
		fs.mkdirSync(dir, { recursive: true });
		const binary = i % 5 === 0;
		const body = binary
			? Buffer.from([0, 1, 2, 3, i & 0xff, 254, 255])
			: `file ${i} ` + "lorem ipsum dolor sit amet ".repeat(25) + "\n";
		fs.writeFileSync(path.join(dir, `f${i}.${binary ? "bin" : "txt"}`), body);
	}
}

tmp.setGracefulCleanup();

describe("init/clone round-trip", () => {
	it("round-trips a multi-file tree byte-identically", async () => {
		const server = inject("server");
		const base = tmp.dirSync({ unsafeCleanup: true }).name;
		const src = path.join(base, "src");
		const dst = path.join(base, "dst");
		fs.mkdirSync(src);
		generate(src);

		const { url, sync } = await init({ dir: src, shape: "vfs", server });
		expect(sync.unsynced).toEqual([]);
		const cloned = await clone({ url, dir: dst, shape: "vfs", server });
		expect(cloned.files).toBe(N);

		const a = await userFiles(src);
		expect(a.size).toBe(N);
		expect(await userFiles(dst)).toEqual(a);
	});
});
