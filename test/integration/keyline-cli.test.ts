// The keyline CLI end to end, against subduction_cli from subduction's keyline branch.
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { pushwork, readText } from "../cli";
import { homeEnv } from "../home";
import { keylineServerBinary, startKeylineServer } from "../keyline-server";

tmp.setGracefulCleanup();

describe.skipIf(!keylineServerBinary)("keyline CLI", () => {
	let server: Awaited<ReturnType<typeof startKeylineServer>>;
	beforeAll(async () => {
		server = await startKeylineServer();
	});
	afterAll(() => server?.close());

	it("grants read and relay, and checks what each user can do", async () => {
		const work = tmp.dirSync({ unsafeCleanup: true }).name;
		const people = Object.fromEntries(["alice", "bob", "carol", "dave"].map(n => [n, homeEnv(path.join(work, n))]));
		for (const env of Object.values(people)) await fs.mkdir(env.HOME);
		const as = (who: string, args: string[], cwd = work) => pushwork(args, cwd, people[who]);
		const keyline = ["--keyhive-version", "keyline", "--keyhive-server", server.url];
		const repo = path.join(work, "demo");
		await fs.mkdir(repo);
		await fs.writeFile(path.join(repo, "hello.txt"), "hello keyline");

		await as("alice", ["init", "--keyhive", ...keyline], repo);
		const url = (await as("alice", ["url"], repo)).stdout.trim();
		await expect(as("alice", ["keyhive", "access"])).rejects.toThrow("not a pushwork repo");

		// a keyline server hands out its own card, so setting it needs none
		const card = async (who: string) => {
			await as(who, ["keyhive", "server", server.url]);
			return (await as(who, ["keyhive", "contacts", "me", "--keyhive-version", "keyline"])).stdout.trim();
		};
		for (const [who, level] of [
			["bob", "read"],
			["carol", "relay"],
		] as const) {
			await as("alice", ["keyhive", "contacts", "add", who, await card(who)], repo);
			await as("alice", ["keyhive", "access", who, level], repo);
		}
		await card("dave");
		// the server answers keyhive sync from a cache it refreshes every 2s
		await new Promise(r => setTimeout(r, 2500));

		const verdict = async (who: string, extra: string[] = []) =>
			(await as(who, ["--porcelain", "keyhive", "check", url, ...keyline, ...extra])).stdout.match(/verdict\t(.*)/)?.[1];
		expect(await verdict("bob")).toBe("can read");
		expect(await verdict("carol")).toBe("can pull but not read (relay)");
		expect(await verdict("dave")).toBe("can't pull: no access");
		expect(await verdict("dave", ["--app", "patchwork"])).toBe("can't pull: no access");

		await as("bob", ["clone", url, path.join(work, "bob-copy"), ...keyline]);
		expect(await readText(path.join(work, "bob-copy", "hello.txt"))).toBe("hello keyline");
		await expect(as("carol", ["clone", url, path.join(work, "carol-copy"), ...keyline])).rejects.toThrow(
			"you can pull but not read",
		);
		await expect(as("dave", ["clone", url, path.join(work, "dave-copy"), ...keyline])).rejects.toThrow(
			"you don't have access",
		);

		await as("alice", ["keyhive", "public", "read"], repo);
		await new Promise(r => setTimeout(r, 2500));
		expect(await verdict("dave", ["--app", "patchwork"])).toBe("can read");
	}, 180_000);
});
