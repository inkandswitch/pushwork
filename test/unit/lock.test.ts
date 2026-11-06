import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { lock, lockHolder } from "../../src/lock";

describe("lock", () => {
	let dir: string;
	let file: string;
	let holder: ChildProcess;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-lock-"));
		file = path.join(dir, "thing");
		// a live process that isn't really holding the lock (a reused pid, say)
		holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
		await new Promise(resolve => holder.once("spawn", resolve));
	});

	afterEach(() => {
		holder.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("leaves a live holder's lock alone", async () => {
		fs.writeFileSync(`${file}.lock`, String(holder.pid));
		await expect(lock(file)).rejects.toThrow(`in use by pushwork pid ${holder.pid}`);
		// forcing it out names a different holder
		await expect(lock(file, { staleIf: holder.pid! + 1 })).rejects.toThrow("in use");
		expect(await lockHolder(file)).toBe(holder.pid);
	});

	it("gives a lock forced from one holder by several at once to exactly one of them", async () => {
		for (let round = 0; round < 20; round++) {
			fs.writeFileSync(`${file}.lock`, String(holder.pid));
			const results = await Promise.allSettled(
				Array.from({ length: 8 }, () => lock(file, { staleIf: holder.pid })),
			);
			const won = results.filter(r => r.status === "fulfilled");
			expect(won).toHaveLength(1);
			for (const r of results) if (r.status === "rejected") expect(String(r.reason)).toMatch(/in use/);
			expect(await lockHolder(file)).toBe(process.pid);
			await (won[0] as PromiseFulfilledResult<() => Promise<void>>).value();
			expect(fs.existsSync(`${file}.lock`)).toBe(false);
		}
	});

	it("takes over a dead holder's lock once, among several", async () => {
		const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		await new Promise(resolve => dead.once("exit", resolve));
		fs.writeFileSync(`${file}.lock`, String(dead.pid));
		const results = await Promise.allSettled(Array.from({ length: 8 }, () => lock(file)));
		expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
	});

	it("doesn't remove the lock of whoever took it over", async () => {
		const first = await lock(file);
		// the caller has decided this process isn't really holding it
		const second = await lock(file, { staleIf: process.pid });
		await first();
		expect(fs.existsSync(`${file}.lock`)).toBe(true);
		await expect(lock(file)).rejects.toThrow("in use");
		await second();
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});
});
