// The publish flow against the keyhive server (`--mode network`).
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { pushwork, readText, userFiles } from "../cli";

tmp.setGracefulCleanup();

describe("init --publish", () => {
	it("anyone can clone, only the publisher can write", async () => {
		const work = tmp.dirSync({ unsafeCleanup: true }).name;
		const a = path.join(work, "a");
		const b = path.join(work, "b");
		const stranger = { HOME: path.join(work, "stranger") };
		await fs.mkdir(a);
		await fs.mkdir(stranger.HOME);
		await fs.writeFile(path.join(a, "hello.txt"), "hello");

		expect((await pushwork(["--porcelain", "init", "--publish"], a)).stdout).toContain("sync\tsynced");
		const url = (await pushwork(["url"], a)).stdout.trim();
		await pushwork(["clone", url, b], work, stranger);
		expect(await userFiles(b)).toEqual(await userFiles(a));

		await fs.writeFile(path.join(b, "hello.txt"), "edited by a stranger");
		await expect(pushwork(["sync"], b, stranger)).rejects.toThrow("read-only repo");
		await pushwork(["cut"], b, stranger);

		await fs.writeFile(path.join(a, "hello.txt"), "edited by the publisher");
		expect((await pushwork(["--porcelain", "sync"], a)).stdout).toContain("sync\tsynced");
		expect((await pushwork(["--porcelain", "sync"], b, stranger)).stdout).toContain("sync\tsynced");
		expect(await readText(path.join(b, "hello.txt"))).toBe("edited by the publisher");
	}, 180_000);
});
