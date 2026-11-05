import * as fs from "fs/promises";

const alive = (pid: number) => {
	try {
		return pid > 0 && process.kill(pid, 0);
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

// `file.lock` holds the owner's pid; one left by a run that died is taken over
export async function lock(file: string): Promise<() => Promise<void>> {
	const lockFile = `${file}.lock`;
	const tmp = `${lockFile}.${process.pid}`;
	await fs.writeFile(tmp, String(process.pid));
	try {
		for (let stale = false; ; stale = true) {
			const taken = await fs.link(tmp, lockFile).then(
				() => true,
				e => {
					if (e.code === "EEXIST") return false;
					throw e;
				},
			);
			if (taken) return () => fs.rm(lockFile, { force: true });
			const pid = Number(await fs.readFile(lockFile, "utf8").catch(() => 0));
			if (stale || alive(pid)) {
				throw new Error(`${file} is in use by pushwork pid ${pid} (delete ${lockFile} if that process is gone)`);
			}
			await fs.rm(lockFile, { force: true });
		}
	} finally {
		await fs.unlink(tmp);
	}
}
