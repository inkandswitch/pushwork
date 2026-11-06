import * as fs from "fs/promises";

/** Whether process `pid` is running. */
export const alive = (pid: number) => {
	try {
		return pid > 0 && process.kill(pid, 0);
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

const read = (file: string) => fs.readFile(file, "utf8").catch(() => "");
// a lock holds its owner's pid, then a token naming the lock itself
const pidIn = (text: string) => parseInt(text, 10) || 0;

// A guard left by a process that died while taking over is ignored after this long.
const GUARD_MS = 10_000;

// Remove a lock whose owner `pid` is gone, unless another process is taking it over, or already
// has: with two of them, the second would otherwise remove the lock the first just took.
async function takeOver(lockFile: string, pid: number): Promise<void> {
	const guard = `${lockFile}.takeover`;
	const guarded = await fs.writeFile(guard, String(process.pid), { flag: "wx" }).then(
		() => true,
		e => {
			if (e.code === "EEXIST") return false;
			throw e;
		},
	);
	if (!guarded) {
		const st = await fs.stat(guard).catch(() => undefined);
		if (st && Date.now() - st.mtimeMs > GUARD_MS) await fs.rm(guard, { force: true });
		return;
	}
	try {
		if (pidIn(await read(lockFile)) === pid) await fs.rm(lockFile, { force: true });
	} finally {
		await fs.rm(guard, { force: true });
	}
}

/**
 * Hold `file.lock`, which holds the owner's pid; one left by a run that died is taken over.
 * So is one held by `staleIf`, alive or not: the caller has decided that process isn't
 * really holding it. Returns the unlock, which removes the lock only while it's still this
 * one, so a holder whose lock was taken over can't remove its successor's.
 */
export async function lock(file: string, { staleIf }: { staleIf?: number } = {}): Promise<() => Promise<void>> {
	const lockFile = `${file}.lock`;
	// one process (the daemon) may take several locks at once
	const token = `${process.pid} ${crypto.randomUUID()}`;
	const tmp = `${lockFile}.${process.pid}.${token.split(" ")[1]}`;
	await fs.writeFile(tmp, token);
	try {
		for (let stale = false; ; stale = true) {
			const taken = await fs.link(tmp, lockFile).then(
				() => true,
				e => {
					if (e.code === "EEXIST") return false;
					throw e;
				},
			);
			if (taken) {
				return async () => {
					if ((await read(lockFile)) === token) await fs.rm(lockFile, { force: true });
				};
			}
			const pid = pidIn(await read(lockFile));
			if (stale || (alive(pid) && pid !== staleIf)) {
				throw new Error(`${file} is in use by pushwork pid ${pid} (delete ${lockFile} if that process is gone)`);
			}
			await takeOver(lockFile, pid);
		}
	} finally {
		await fs.unlink(tmp);
	}
}

/** The pid in `file.lock`, or 0 if there's none. */
export const lockHolder = async (file: string): Promise<number> => pidIn(await read(`${file}.lock`));
