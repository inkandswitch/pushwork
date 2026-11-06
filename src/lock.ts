import * as fs from "fs/promises";

const alive = (pid: number) => {
	try {
		return pid > 0 && process.kill(pid, 0);
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

const readPid = async (file: string) => Number(await fs.readFile(file, "utf8").catch(() => 0));

const linked = (from: string, to: string) =>
	fs.link(from, to).then(
		() => true,
		e => {
			if (e.code === "EEXIST") return false;
			throw e;
		},
	);

// A guard left by a process that died while taking over is ignored after this long.
const GUARD_MS = 10_000;

// Remove a lock whose owner `pid` died, unless another process is taking it over, or already
// has: with two of them, the second would otherwise remove the lock the first just took.
async function takeOver(lockFile: string, tmp: string, pid: number): Promise<void> {
	const guard = `${lockFile}.takeover`;
	if (!(await linked(tmp, guard))) {
		const st = await fs.stat(guard).catch(() => undefined);
		if (st && Date.now() - st.mtimeMs > GUARD_MS) await fs.rm(guard, { force: true });
		return;
	}
	try {
		if ((await readPid(lockFile)) === pid) await fs.rm(lockFile, { force: true });
	} finally {
		await fs.rm(guard, { force: true });
	}
}

// `file.lock` holds the owner's pid; one left by a run that died is taken over
export async function lock(file: string): Promise<() => Promise<void>> {
	const lockFile = `${file}.lock`;
	// one process (the daemon) may take several locks at once
	const tmp = `${lockFile}.${process.pid}.${crypto.randomUUID()}`;
	await fs.writeFile(tmp, String(process.pid));
	try {
		for (let stale = false; ; stale = true) {
			if (await linked(tmp, lockFile)) return () => fs.rm(lockFile, { force: true });
			const pid = await readPid(lockFile);
			if (stale || alive(pid)) {
				throw new Error(`${file} is in use by pushwork pid ${pid} (delete ${lockFile} if that process is gone)`);
			}
			await takeOver(lockFile, tmp, pid);
		}
	} finally {
		await fs.unlink(tmp);
	}
}
