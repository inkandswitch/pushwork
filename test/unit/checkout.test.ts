import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { lockCheckout, readHeads, writeHeads } from "../../src/checkout.js";
import type { DocumentId } from "../../src/url.js";
import { setHome } from "../home";

async function checkout(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-checkout-"));
	await fs.mkdir(path.join(root, ".pushwork"));
	return root;
}

describe("checkout heads", () => {
	it("round-trips through heads.json", async () => {
		const root = await checkout();
		const heads = new Map([
			["qLoujReChD4mrphFKSHcteTf7m" as DocumentId, ["a".repeat(64)]],
			["2Lp9ZYjCDK3hAJmbrL2ZvbTJZaFe" as DocumentId, ["b".repeat(64), "c".repeat(64)]],
		]);
		await writeHeads(root, heads);
		expect(await readHeads(root)).toEqual(heads);
		expect(await fs.readdir(path.join(root, ".pushwork"))).toEqual(["heads.json"]);
	});

	it("reads no heads when there's no heads.json", async () => {
		expect((await readHeads(await checkout())).size).toBe(0);
	});

	it("names a corrupt heads.json", async () => {
		const root = await checkout();
		await fs.writeFile(path.join(root, ".pushwork", "heads.json"), `{"version":1,"heads":`);
		await expect(readHeads(root)).rejects.toThrow(/heads\.json is corrupt/);
	});

	it("rejects a heads.json of the wrong shape", async () => {
		const root = await checkout();
		await fs.writeFile(path.join(root, ".pushwork", "heads.json"), `{"version":1,"heads":{"x":"y"}}`);
		await expect(readHeads(root)).rejects.toThrow(/heads\.json is corrupt .*pushwork sync/);
	});
});

describe("checkout lock", () => {
	let restoreHome: () => void;
	let home: string;

	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-home-"));
		restoreHome = setHome(home);
	});

	afterEach(async () => {
		restoreHome();
		await fs.rm(home, { recursive: true, force: true });
	});

	it("says the daemon is running a command in the checkout when it holds the lock", async () => {
		const root = await checkout();
		// held by this process, which the pid file names as the daemon
		const unlock = await lockCheckout(root);
		await fs.mkdir(path.join(home, ".pushwork"));
		await fs.writeFile(path.join(home, ".pushwork", "daemon.pid"), String(process.pid));
		try {
			await expect(lockCheckout(root)).rejects.toThrow(
				new Error(
					`the pushwork daemon (pid ${process.pid}) is still running a command in this checkout; wait for it, or run \`pushwork daemon stop\``,
				),
			);
		} finally {
			await unlock();
		}
	});

	it("names the lock file when another process holds it", async () => {
		const root = await checkout();
		const unlock = await lockCheckout(root);
		try {
			await expect(lockCheckout(root)).rejects.toThrow(`in use by pushwork pid ${process.pid} (delete`);
		} finally {
			await unlock();
		}
	});
});
