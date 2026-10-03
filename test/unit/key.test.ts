import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { loadSeed, signerFrom } from "../../src/key.js";

let home: string;
const saved = process.env.HOME;
const keyFile = () => path.join(home, ".pushwork", "key");

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-key-"));
	process.env.HOME = home;
});

afterEach(async () => {
	process.env.HOME = saved;
	await fs.rm(home, { recursive: true, force: true });
});

describe("loadSeed", () => {
	it("creates a 0600 hex key once and reuses it", async () => {
		const seed = await loadSeed();
		expect(seed.length).toBe(32);
		const text = await fs.readFile(keyFile(), "utf8");
		expect(text.trim()).toBe(Buffer.from(seed).toString("hex"));
		expect((await fs.stat(keyFile())).mode & 0o777).toBe(0o600);
		expect(await loadSeed()).toEqual(seed);
		expect(await fs.readdir(path.dirname(keyFile()))).toEqual(["key"]);
	});

	it("agrees on one key when created concurrently", async () => {
		const seeds = await Promise.all([loadSeed(), loadSeed(), loadSeed()]);
		expect(seeds[1]).toEqual(seeds[0]);
		expect(seeds[2]).toEqual(seeds[0]);
	});

	it("throws on a malformed key file", async () => {
		await fs.mkdir(path.dirname(keyFile()), { recursive: true });
		await fs.writeFile(keyFile(), "not a key\n");
		await expect(loadSeed()).rejects.toThrow(/malformed key file/);
	});

	it("gives a stable signer", async () => {
		const seed = await loadSeed();
		expect(signerFrom(seed).verifyingKey()).toEqual(signerFrom(seed).verifyingKey());
	});
});
