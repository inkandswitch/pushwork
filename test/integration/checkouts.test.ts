// Two checkouts of one url on one machine share the store but each keeps its own heads.
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import { inject } from "vitest";
import { exists, pushwork, readText, stopDaemons } from "../cli";
import { homeEnv } from "../home";

const server = inject("server");

const urlOf = async (dir: string) => (await pushwork(["url"], dir)).stdout.trim();
const porcelainStatus = async (dir: string) => (await pushwork(["--porcelain", "status"], dir)).stdout;

describe("checkouts", () => {
	let work: string;
	let cleanup: () => void;
	let a: string;
	let b: string;

	beforeEach(async () => {
		const t = tmp.dirSync({ unsafeCleanup: true });
		work = t.name;
		cleanup = t.removeCallback;
		a = path.join(work, "a");
		b = path.join(work, "b");
		await fs.mkdir(a);
		await fs.writeFile(path.join(a, "notes.txt"), "one\ntwo\nthree\n");
		await pushwork(["init", "--sync-server", server], a);
		await pushwork(["clone", "--sync-server", server, await urlOf(a), b]);
	});

	afterEach(async () => {
		await stopDaemons();
		cleanup();
	});

	const notes = (dir: string) => path.join(dir, "notes.txt");

	// replace line n (1-based) of dir's notes.txt
	async function edit(dir: string, n: number, text: string) {
		const lines = (await readText(notes(dir))).split("\n");
		lines[n - 1] = text;
		await fs.writeFile(notes(dir), lines.join("\n"));
	}

	const line = async (dir: string, n: number) => (await readText(notes(dir))).split("\n")[n - 1];

	it("a sync in one checkout leaves the other's status clean", async () => {
		await edit(a, 1, "ONE");
		await pushwork(["sync"], a);
		expect(await porcelainStatus(b)).toBe("");
	});

	it("edits to one file from two checkouts both survive", async () => {
		await edit(a, 1, "ONE");
		await pushwork(["sync"], a);
		await edit(b, 3, "THREE");
		await pushwork(["sync"], b);
		expect(await readText(notes(b))).toBe("ONE\ntwo\nTHREE\n");
		await pushwork(["sync"], a);
		expect(await readText(notes(a))).toBe(await readText(notes(b)));
	});

	it("save doesn't pull in another checkout's changes", async () => {
		await edit(b, 3, "THREE");
		await pushwork(["save"], b);
		await edit(a, 1, "ONE");
		await pushwork(["sync"], a);
		expect(await porcelainStatus(b)).toBe("");
		expect(await line(b, 1)).toBe("one");
		await pushwork(["sync"], b);
		expect(await readText(notes(b))).toBe("ONE\ntwo\nTHREE\n");
	});

	it("save leaves out what another checkout already synced", async () => {
		await edit(a, 1, "ONE");
		await pushwork(["sync"], a);
		await edit(b, 3, "THREE");
		await pushwork(["save"], b);
		expect(await line(b, 1)).toBe("one");
		expect(await porcelainStatus(b)).toBe("");
		await pushwork(["sync"], b);
		expect(await readText(notes(b))).toBe("ONE\ntwo\nTHREE\n");
	});

	it("two checkouts can sync at the same moment", async () => {
		await edit(a, 1, "ONE");
		await edit(b, 3, "THREE");
		await Promise.all([pushwork(["sync"], a), pushwork(["sync"], b)]);
		await pushwork(["sync"], a);
		await pushwork(["sync"], b);
		expect(await readText(notes(a))).toBe("ONE\ntwo\nTHREE\n");
		expect(await readText(notes(b))).toBe(await readText(notes(a)));
	});

	it("works without heads.json", async () => {
		const heads = path.join(b, ".pushwork", "heads.json");
		await fs.rm(heads);
		expect(await porcelainStatus(b)).toBe("");
		await pushwork(["sync"], b);
		expect(await exists(heads)).toBe(true);
	});

	it("a running command in the same checkout blocks another", async () => {
		await fs.writeFile(path.join(b, ".pushwork", "checkout.lock"), String(process.pid));
		await expect(pushwork(["sync"], b)).rejects.toThrow(/in use by pushwork pid/);
		expect(await porcelainStatus(b)).toBe("");
	});

	it("a lock left by a dead process is taken over", async () => {
		let pid = 999999;
		while (alive(pid)) pid++;
		await fs.writeFile(path.join(b, ".pushwork", "checkout.lock"), String(pid));
		await pushwork(["sync"], b);
		expect(await exists(path.join(b, ".pushwork", "checkout.lock"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")("a sync that fails after its commit doesn't commit the edit again", async () => {
		// a's new folder can't be written into b, so b's sync fails after it saved and pushed its commit
		await fs.mkdir(path.join(a, "sub"));
		await fs.writeFile(path.join(a, "sub", "new.txt"), "new\n");
		await pushwork(["sync"], a);
		await edit(b, 3, "THREE");
		await fs.chmod(b, 0o500);
		try {
			await expect(pushwork(["sync"], b)).rejects.toThrow(/EACCES/);
		} finally {
			await fs.chmod(b, 0o700);
		}
		expect(await porcelainStatus(b)).toBe("");
		await pushwork(["sync"], b);
		expect(await readText(notes(b))).toBe("one\ntwo\nTHREE\n");
		expect(await readText(path.join(b, "sub", "new.txt"))).toBe("new\n");
	});

	it("clone writes what the server has, not an older copy in the store", async () => {
		// another machine moves the repo on; this machine's store still has it as a and b left it
		const elsewhere = path.join(work, "elsewhere");
		await fs.mkdir(elsewhere);
		const c = path.join(work, "c");
		await pushwork(["clone", "--sync-server", server, await urlOf(a), c], undefined, homeEnv(elsewhere));
		await edit(c, 1, "ONE");
		await pushwork(["sync"], c, homeEnv(elsewhere));

		const d = path.join(work, "d");
		await pushwork(["clone", "--sync-server", server, await urlOf(a), d]);
		expect(await readText(notes(d))).toBe("ONE\ntwo\nthree\n");
		expect(await porcelainStatus(d)).toBe("");
	});

	it("no .pushwork/storage is written", async () => {
		await pushwork(["sync"], b);
		for (const dir of [a, b]) expect(await exists(path.join(dir, ".pushwork", "storage"))).toBe(false);
	});
});

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}
