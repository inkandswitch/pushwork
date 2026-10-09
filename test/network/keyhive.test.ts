// Keyhive repos against the keyhive server (`--mode network`).
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { pushwork, readText, userFiles } from "../cli";
import { homeEnv } from "../home";

tmp.setGracefulCleanup();

async function setup() {
	const work = tmp.dirSync({ unsafeCleanup: true }).name;
	const a = path.join(work, "a");
	const b = path.join(work, "b");
	const stranger = homeEnv(path.join(work, "stranger"));
	await fs.mkdir(a);
	await fs.mkdir(stranger.HOME);
	await fs.writeFile(path.join(a, "hello.txt"), "hello");
	return { work, a, b, stranger };
}

describe("init --keyhive", () => {
	it("--public-access read: anyone can clone, only the owner can write", async () => {
		const { work, a, b, stranger } = await setup();

		expect((await pushwork(["--porcelain", "init", "--keyhive", "--public-access", "read"], a)).stdout).toContain(
			"sync\tsynced",
		);
		const url = (await pushwork(["url"], a)).stdout.trim();
		await pushwork(["clone", url, b], work, stranger);
		expect(await userFiles(b)).toEqual(await userFiles(a));

		await fs.writeFile(path.join(b, "hello.txt"), "edited by a stranger");
		await expect(pushwork(["sync"], b, stranger)).rejects.toThrow("read-only repo");
		await pushwork(["cut"], b, stranger);

		await fs.writeFile(path.join(a, "hello.txt"), "edited by the owner");
		expect((await pushwork(["--porcelain", "sync"], a)).stdout).toContain("sync\tsynced");
		expect((await pushwork(["--porcelain", "sync"], b, stranger)).stdout).toContain("sync\tsynced");
		expect(await readText(path.join(b, "hello.txt"))).toBe("edited by the owner");
	}, 180_000);

	it("without public access, a stranger can't clone", async () => {
		const { work, a, b, stranger } = await setup();
		expect((await pushwork(["--porcelain", "init", "--keyhive"], a)).stdout).toContain("sync\tsynced");
		const url = (await pushwork(["url"], a)).stdout.trim();
		await expect(pushwork(["clone", url, b], work, stranger)).rejects.toThrow("you don't have access");
	}, 180_000);

	it("--public-access edit: a stranger's edits reach the owner", async () => {
		const { work, a, b, stranger } = await setup();
		await pushwork(["init", "--keyhive", "--public-access", "edit"], a);
		const url = (await pushwork(["url"], a)).stdout.trim();
		await pushwork(["clone", url, b], work, stranger);

		await fs.writeFile(path.join(b, "hello.txt"), "edited by a stranger");
		await fs.writeFile(path.join(b, "new.txt"), "new from a stranger");
		expect((await pushwork(["--porcelain", "sync"], b, stranger)).stdout).toContain("sync\tsynced");
		await pushwork(["sync"], a);
		expect(await readText(path.join(a, "hello.txt"))).toBe("edited by a stranger");
		expect(await readText(path.join(a, "new.txt"))).toBe("new from a stranger");
	}, 180_000);

	it("--sync-server: data on one server, keyhive on another", async () => {
		const { work, a, b, stranger } = await setup();
		const sync = "wss://subduction.sync.inkandswitch.com";
		await pushwork(["init", "--keyhive", "--public-access", "read", "--sync-server", sync], a);
		const config = JSON.parse(await readText(path.join(a, ".pushwork", "config.json")));
		expect(config).toMatchObject({ syncServer: sync, keyhiveServer: "keyhive" });
		const url = (await pushwork(["url"], a)).stdout.trim();
		await pushwork(["clone", "--sync-server", sync, url, b], work, stranger);
		expect(await userFiles(b)).toEqual(await userFiles(a));

		await fs.writeFile(path.join(a, "hello.txt"), "edited by the owner");
		expect((await pushwork(["--porcelain", "sync"], a)).stdout).toContain("sync\tsynced");
		await pushwork(["sync"], b, stranger);
		expect(await readText(path.join(b, "hello.txt"))).toBe("edited by the owner");
	}, 180_000);
});
