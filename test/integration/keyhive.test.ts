/**
 * Black-box integration test for the keyhive backend: two identities, one
 * repo. Owner inits a world-readable repo, a second identity clones it
 * read-only, gets granted edit, and changes flow both ways.
 *
 * Talks to a public keyhive-speaking sync server, so it is slow and needs the
 * network. Defaults to wss://keyhive.sync.automerge.org, the relay known to
 * answer keyhive sync; set PUSHWORK_KEYHIVE_SERVER=subduction to run it
 * against the inkandswitch server instead.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { execFile } from "child_process";
import { promisify } from "util";
import { webcrypto } from "node:crypto";

const execFileP = promisify(execFile);
const CLI = path.join(__dirname, "..", "..", "dist", "cli.js");

const TEST_TIMEOUT = 300_000;

async function pushwork(
	home: string,
	args: string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
	try {
		return await execFileP("node", [CLI, ...args], {
			cwd,
			env: {
				...process.env,
				FORCE_COLOR: "0",
				NO_COLOR: "1",
				PUSHWORK_HOME: home,
				PUSHWORK_KEYHIVE_SERVER: process.env.PUSHWORK_KEYHIVE_SERVER ?? "keyhive",
			},
			timeout: 120_000,
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch (err: any) {
		throw new Error(
			[
				`pushwork ${args.join(" ")} failed (cwd=${cwd ?? process.cwd()})`,
				err.message,
				err.stdout ? `stdout: ${err.stdout}` : "",
				err.stderr ? `stderr: ${err.stderr}` : "",
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
}

async function freshIdentity(): Promise<string> {
	const kp = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	]);
	return JSON.stringify({ key: await webcrypto.subtle.exportKey("jwk", kp.privateKey) });
}

const porcelain = (stdout: string): Map<string, string> =>
	new Map(
		stdout
			.split("\n")
			.filter(Boolean)
			.map((l) => l.split("\t") as [string, string]),
	);

describe("pushwork — keyhive backend", () => {
	let root: string;
	let cleanup: () => void;
	let homeA: string;
	let homeB: string;

	beforeEach(async () => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		root = t.name;
		cleanup = t.removeCallback;
		homeA = path.join(root, "homeA");
		homeB = path.join(root, "homeB");
		await pushwork(homeA, ["keyhive", "use", await freshIdentity()]);
		await pushwork(homeB, ["keyhive", "use", await freshIdentity()]);
	});

	afterEach(() => cleanup());

	it(
		"init protects the repo, a stranger clones it read-only, a grant lets them edit",
		async () => {
			const repoA = path.join(root, "a");
			await fs.mkdir(path.join(repoA, "sub"), { recursive: true });
			await fs.writeFile(path.join(repoA, "hello.txt"), "hello\n");
			await fs.writeFile(path.join(repoA, "sub", "world.txt"), "world\n");

			const init = porcelain((await pushwork(homeA, ["--porcelain", "init", repoA])).stdout);
			expect(init.get("Backend")).toBe("subduction");
			expect(init.get("Keyhive")).toMatch(/^identity [0-9a-f]{64}$/);
			expect(init.get("Access")).toBe("admin");
			expect(
				JSON.parse(await fs.readFile(path.join(repoA, ".pushwork", "config.json"), "utf8")),
			).toMatchObject({ backend: "subduction", keyhive: true });
			const url = init.get("ok\tINITIALIZED") ?? (await pushwork(homeA, ["url"], repoA)).stdout.trim();
			expect(url).toMatch(/^automerge:/);

			const members = (await pushwork(homeA, ["--porcelain", "keyhive", "list"], repoA)).stdout;
			expect(members).toMatch(/^admin\t.*\tself$/m);
			expect(members).toMatch(/^read\t.*\tpublic$/m);
			expect(members).toMatch(/^pull\t.*\tserver$/m);

			const repoB = path.join(root, "b");
			const cloned = await pushwork(homeB, ["clone", url, repoB]);
			expect(cloned.stdout).toMatch(/Access\s+read/);
			expect(cloned.stdout + cloned.stderr).toMatch(/your access to this repo is READ/);
			expect(await fs.readFile(path.join(repoB, "sub", "world.txt"), "utf8")).toBe("world\n");

			const status = porcelain(
				(await pushwork(homeB, ["--porcelain", "keyhive", "status"], repoB)).stdout,
			);
			expect(status.get("access")).toBe("read");
			const card = status.get("contact-card")!;
			expect(card.startsWith("{")).toBe(true);

			await pushwork(homeA, ["keyhive", "grant", "edit", card], repoA);
			const after = (await pushwork(homeA, ["--porcelain", "keyhive", "list"], repoA)).stdout;
			expect(after).toMatch(/^edit\t/m);

			// B: pick up the grant, then push an edit and a new file.
			await pushwork(homeB, ["sync"], repoB);
			await fs.appendFile(path.join(repoB, "hello.txt"), "from b\n");
			await fs.writeFile(path.join(repoB, "new.txt"), "new\n");
			await pushwork(homeB, ["sync"], repoB);

			await pushwork(homeA, ["sync"], repoA);
			expect(await fs.readFile(path.join(repoA, "hello.txt"), "utf8")).toBe("hello\nfrom b\n");
			expect(await fs.readFile(path.join(repoA, "new.txt"), "utf8")).toBe("new\n");

			// And back: A edits, B sees it.
			await fs.appendFile(path.join(repoA, "sub", "world.txt"), "from a\n");
			await pushwork(homeA, ["sync"], repoA);
			await pushwork(homeB, ["sync"], repoB);
			expect(await fs.readFile(path.join(repoB, "sub", "world.txt"), "utf8")).toBe(
				"world\nfrom a\n",
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"--no-world-read keeps strangers out, and clone says so",
		async () => {
			const repoA = path.join(root, "private");
			await fs.mkdir(repoA, { recursive: true });
			await fs.writeFile(path.join(repoA, "secret.txt"), "shh\n");
			await pushwork(homeA, ["init", "--no-world-read", repoA]);
			const members = (await pushwork(homeA, ["--porcelain", "keyhive", "list"], repoA)).stdout;
			expect(members).not.toMatch(/public/);

			const url = (await pushwork(homeA, ["url"], repoA)).stdout.trim();
			await expect(
				pushwork(homeB, ["clone", url, path.join(root, "nope")]),
			).rejects.toThrow(/no access to|grant read/);
		},
		TEST_TIMEOUT,
	);

	it(
		"--no-keyhive makes a plain repo even with an identity in use",
		async () => {
			const repo = path.join(root, "plain");
			await fs.mkdir(repo, { recursive: true });
			await fs.writeFile(path.join(repo, "a.txt"), "a\n");
			const init = porcelain(
				(await pushwork(homeA, ["--porcelain", "init", "--no-keyhive", repo])).stdout,
			);
			expect(init.get("Backend")).toBe("subduction");
			expect(init.has("Keyhive")).toBe(false);
		},
		TEST_TIMEOUT,
	);
});
