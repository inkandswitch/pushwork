// `pushwork migrate` from version 6, which kept each checkout's documents in its own .pushwork/storage.
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { exists, pushwork, readText } from "../cli";
import { homeEnv } from "../home";

// nothing listens here, so a migrate that reached for the server would fail
const UNREACHABLE = "ws://127.0.0.1:1";

const pushworkDir = (repo: string) => path.join(repo, ".pushwork");
const configFile = (repo: string) => path.join(pushworkDir(repo), "config.json");
const readConfigFile = async (repo: string) => JSON.parse(await readText(configFile(repo)));

describe("migrate from version 6", () => {
	let work: string;
	let cleanup: () => void;
	let repo: string;
	let h2: string;
	let url: string;

	beforeEach(async () => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		work = t.name;
		cleanup = t.removeCallback;
		repo = path.join(work, "repo");
		h2 = path.join(work, "h2");
		await fs.mkdir(repo);
		await fs.mkdir(h2);
		await fs.writeFile(path.join(repo, "notes.txt"), "one\ntwo\n");
		await fs.mkdir(path.join(repo, "sub"));
		await fs.writeFile(path.join(repo, "sub", "deep.txt"), "deep");
		url = await v6(repo, path.join(work, "h1"));
	});

	afterEach(async () => {
		// a failed test may leave the read-only store behind, which tmp can't remove
		await fs.chmod(path.join(h2, ".pushwork", "storage"), 0o700).catch(() => {});
		cleanup();
	});

	// A version 6 checkout of dir: init in its own home, then put that home's store where v6 kept it.
	async function v6(dir: string, home: string): Promise<string> {
		await fs.mkdir(home, { recursive: true });
		await pushwork(["init", "--offline"], dir, homeEnv(home));
		const url = (await pushwork(["url"], dir, homeEnv(home))).stdout.trim();
		await fs.rename(path.join(home, ".pushwork", "storage"), path.join(pushworkDir(dir), "storage"));
		await fs.rm(path.join(pushworkDir(dir), "heads.json"));
		const config = await readConfigFile(dir);
		await fs.writeFile(configFile(dir), JSON.stringify({ ...config, version: 6, syncServer: UNREACHABLE }, null, 2));
		return url;
	}

	const run = (args: string[]) => pushwork(args, repo, homeEnv(h2));
	const porcelainStatus = async () => (await run(["--porcelain", "status"])).stdout;

	it("migrates a v6 checkout offline", async () => {
		await expect(run(["status"])).rejects.toThrow(/pushwork migrate/);
		await run(["migrate"]);
		expect(await porcelainStatus()).toBe("");
		expect(await exists(path.join(pushworkDir(repo), "heads.json"))).toBe(true);
		expect((await fs.readdir(path.join(h2, ".pushwork", "storage", "trees"))).length).toBeGreaterThan(0);
		expect(await exists(path.join(pushworkDir(repo), "pushwork_migration_backup_safe_to_delete", "storage"))).toBe(true);
		expect(await exists(path.join(pushworkDir(repo), "storage"))).toBe(false);
		expect((await readConfigFile(repo)).version).toBe(7);
		expect((await run(["url"])).stdout.trim()).toBe(url);
	});

	it.skipIf(process.platform === "win32")("a failed migration leaves a working v6 repo, and a rerun succeeds", async () => {
		const store = path.join(h2, ".pushwork", "storage");
		await fs.mkdir(store, { recursive: true });
		await fs.chmod(store, 0o500);
		const before = await fs.readdir(path.join(pushworkDir(repo), "storage", "trees"), { recursive: true });

		await expect(run(["migrate"])).rejects.toThrow(/EACCES/);
		expect((await readConfigFile(repo)).version).toBe(6);
		expect(await fs.readdir(path.join(pushworkDir(repo), "storage", "trees"), { recursive: true })).toEqual(before);
		expect(await exists(path.join(pushworkDir(repo), "heads.json"))).toBe(false);
		expect(await exists(path.join(pushworkDir(repo), "checkout.lock"))).toBe(false);

		await fs.chmod(store, 0o700);
		await run(["migrate"]);
		expect(await porcelainStatus()).toBe("");
	});

	it.skipIf(process.platform === "win32")("a migration that fails at the last step puts the old storage back", async () => {
		const before = await fs.readdir(path.join(pushworkDir(repo), "storage", "trees"), { recursive: true });
		await fs.chmod(configFile(repo), 0o400);

		await expect(run(["migrate"])).rejects.toThrow(/EACCES.*config\.json/);
		expect((await readConfigFile(repo)).version).toBe(6);
		expect(await fs.readdir(path.join(pushworkDir(repo), "storage", "trees"), { recursive: true })).toEqual(before);
		expect(await exists(path.join(pushworkDir(repo), "pushwork_migration_backup_safe_to_delete"))).toBe(false);
		expect(await exists(path.join(pushworkDir(repo), "heads.json"))).toBe(false);
		expect(await exists(path.join(pushworkDir(repo), "checkout.lock"))).toBe(false);

		await fs.chmod(configFile(repo), 0o600);
		await run(["migrate"]);
		expect(await porcelainStatus()).toBe("");
	});

	it("leaves the machine store where it is for a checkout at the home directory", async () => {
		const home = path.join(work, "home");
		await fs.mkdir(home);
		await fs.writeFile(path.join(home, "notes.txt"), "at home\n");
		// built in place: the home's own store is where v6 kept this checkout's documents
		await pushwork(["init", "--offline"], home, homeEnv(home));
		const homeUrl = (await pushwork(["url"], home, homeEnv(home))).stdout.trim();
		await fs.rm(path.join(pushworkDir(home), "heads.json"));
		const config = await readConfigFile(home);
		await fs.writeFile(configFile(home), JSON.stringify({ ...config, version: 6, syncServer: UNREACHABLE }, null, 2));

		// --sync-server is saved, and still not contacted
		await pushwork(["migrate", "--sync-server", "ws://127.0.0.1:2"], home, homeEnv(home));
		expect((await readConfigFile(home)).syncServer).toBe("ws://127.0.0.1:2");
		expect((await fs.readdir(path.join(pushworkDir(home), "storage", "trees"))).length).toBeGreaterThan(0);
		expect(await exists(path.join(pushworkDir(home), "pushwork_migration_backup_safe_to_delete", "storage"))).toBe(false);
		expect(await exists(path.join(pushworkDir(home), "heads.json"))).toBe(true);
		expect((await readConfigFile(home)).version).toBe(7);
		expect((await pushwork(["--porcelain", "status"], home, homeEnv(home))).stdout).toBe("");
		expect((await pushwork(["url"], home, homeEnv(home))).stdout.trim()).toBe(homeUrl);
	});
});
