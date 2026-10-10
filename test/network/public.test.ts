// One init/clone/sync round trip against the public server (`--mode network`).
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { pushwork, readText, userFiles } from "../cli";

tmp.setGracefulCleanup();

describe("public server", () => {
	it("init, clone and sync", async () => {
		const work = tmp.dirSync({ unsafeCleanup: true }).name;
		const a = path.join(work, "a");
		const b = path.join(work, "b");
		await fs.mkdir(a);
		await fs.writeFile(path.join(a, "hello.txt"), "hello");

		expect((await pushwork(["--porcelain", "init"], a)).stdout).toContain("sync\tsynced");
		const url = (await pushwork(["url"], a)).stdout.trim();
		await pushwork(["clone", url, b]);
		expect(await userFiles(b)).toEqual(await userFiles(a));

		await fs.writeFile(path.join(b, "hello.txt"), "edited in b");
		expect((await pushwork(["--porcelain", "sync"], b)).stdout).toContain("sync\tsynced");
		await pushwork(["sync"], a);
		expect(await readText(path.join(a, "hello.txt"))).toBe("edited in b");
	});
});
