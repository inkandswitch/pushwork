import { execFile, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

// Reading a git repository by running git itself: refs, history, trees and
// blobs. Only regular and executable files are read; symlinks and
// submodules aren't files pushwork keeps.

export type TreeFile = { path: string; mode: string; sha: string };

export type TreeChange =
	| { kind: "set"; path: string; sha: string }
	| { kind: "delete"; path: string };

export class GitRepo {
	#blobs: BlobReader | undefined;

	constructor(readonly dir: string) {}

	async run(args: string[]): Promise<string> {
		const { stdout } = await execFileP("git", args, {
			cwd: this.dir,
			maxBuffer: 256 * 1024 * 1024,
		});
		return stdout;
	}

	async ok(args: string[]): Promise<boolean> {
		try {
			await execFileP("git", args, { cwd: this.dir });
			return true;
		} catch {
			return false;
		}
	}

	async resolve(ref: string): Promise<string> {
		return (await this.run(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
	}

	async treeOf(commit: string): Promise<string> {
		return (await this.run(["rev-parse", `${commit}^{tree}`])).trim();
	}

	// The branch HEAD is on, or undefined when it's detached.
	async currentBranch(): Promise<string | undefined> {
		try {
			return (await this.run(["symbolic-ref", "--short", "-q", "HEAD"])).trim() || undefined;
		} catch {
			return undefined;
		}
	}

	async branches(): Promise<string[]> {
		const out = await this.run(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
		return out.split("\n").filter(Boolean);
	}

	async remoteUrl(name = "origin"): Promise<string | undefined> {
		try {
			return (await this.run(["remote", "get-url", name])).trim() || undefined;
		} catch {
			return undefined;
		}
	}

	// The commit `branch` tracks upstream, if it tracks one.
	async upstreamOf(branch: string): Promise<string | undefined> {
		try {
			return (await this.run(["rev-parse", "--verify", "-q", `${branch}@{upstream}`])).trim();
		} catch {
			return undefined;
		}
	}

	// `tip`'s first-parent history, oldest first.
	async firstParents(tip: string): Promise<string[]> {
		const out = await this.run(["rev-list", "--first-parent", "--reverse", tip]);
		return out.split("\n").filter(Boolean);
	}

	async isAncestor(ancestor: string, of: string): Promise<boolean> {
		return this.ok(["merge-base", "--is-ancestor", ancestor, of]);
	}

	async mergeBase(a: string, b: string): Promise<string | undefined> {
		try {
			return (await this.run(["merge-base", a, b])).trim() || undefined;
		} catch {
			return undefined;
		}
	}

	async subject(commit: string): Promise<string> {
		return (await this.run(["log", "-1", "--format=%s", commit])).trim();
	}

	// Every file at a commit.
	async files(commit: string): Promise<TreeFile[]> {
		const out = await this.run(["ls-tree", "-r", "-z", "--full-tree", commit]);
		const files: TreeFile[] = [];
		for (const record of out.split("\0")) {
			if (!record) continue;
			const tab = record.indexOf("\t");
			const [mode, type, sha] = record.slice(0, tab).split(" ");
			if (type === "blob" && isFileMode(mode)) {
				files.push({ path: record.slice(tab + 1), mode, sha });
			}
		}
		return files;
	}

	// What changed to files from `from` to `to`. A path that stops being a
	// file (became a symlink, say) is a delete.
	async changes(from: string, to: string): Promise<TreeChange[]> {
		const out = await this.run(["diff-tree", "-r", "-z", "--no-renames", from, to]);
		const parts = out.split("\0");
		const changes: TreeChange[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) {
			const meta = parts[i];
			const path = parts[i + 1];
			if (!meta.startsWith(":")) {
				i -= 1; // the commit id line diff-tree prints with one argument
				continue;
			}
			const [, newMode, , newSha, status] = meta.slice(1).split(" ");
			if (status === "D" || !isFileMode(newMode)) {
				changes.push({ kind: "delete", path });
			} else {
				changes.push({ kind: "set", path, sha: newSha });
			}
		}
		return changes;
	}

	// A blob's bytes, through one long-running `git cat-file --batch`.
	blob(sha: string): Promise<Uint8Array> {
		this.#blobs ??= new BlobReader(this.dir);
		return this.#blobs.read(sha);
	}

	close(): void {
		this.#blobs?.close();
		this.#blobs = undefined;
	}
}

export function isFileMode(mode: string): boolean {
	return mode === "100644" || mode === "100755";
}

class BlobReader {
	#proc: ChildProcessWithoutNullStreams;
	#queue: { resolve(bytes: Uint8Array): void; reject(err: Error): void }[] = [];
	#buffer = Buffer.alloc(0);

	constructor(dir: string) {
		this.#proc = spawn("git", ["cat-file", "--batch"], { cwd: dir });
		this.#proc.stdout.on("data", (chunk: Buffer) => {
			this.#buffer = Buffer.concat([this.#buffer, chunk]);
			this.#drain();
		});
		this.#proc.on("error", (err) => this.#fail(err));
		this.#proc.on("exit", () => this.#fail(new Error("git cat-file exited")));
	}

	read(sha: string): Promise<Uint8Array> {
		return new Promise((resolve, reject) => {
			this.#queue.push({ resolve, reject });
			this.#proc.stdin.write(`${sha}\n`);
		});
	}

	close(): void {
		this.#proc.stdin.end();
	}

	// Answers come back in order: "<sha> <type> <size>\n<bytes>\n".
	#drain(): void {
		for (;;) {
			const waiting = this.#queue[0];
			if (!waiting) return;
			const newline = this.#buffer.indexOf(10);
			if (newline < 0) return;
			const header = this.#buffer.subarray(0, newline).toString();
			if (header.endsWith(" missing")) {
				this.#buffer = this.#buffer.subarray(newline + 1);
				this.#queue.shift();
				waiting.reject(new Error(`git has no object ${header.split(" ")[0]}`));
				continue;
			}
			const size = Number(header.split(" ")[2]);
			const end = newline + 1 + size;
			if (this.#buffer.length < end + 1) return;
			const bytes = new Uint8Array(this.#buffer.subarray(newline + 1, end));
			this.#buffer = this.#buffer.subarray(end + 1);
			this.#queue.shift();
			waiting.resolve(bytes);
		}
	}

	#fail(err: Error): void {
		for (const waiting of this.#queue.splice(0)) waiting.reject(err);
	}
}

// A GitHub repo named by a remote url: git@github.com:owner/name(.git) or
// https://github.com/owner/name(.git).
export function githubRepoOf(url: string | undefined): { owner: string; repo: string } | undefined {
	if (!url) return undefined;
	const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
	return match ? { owner: match[1], repo: match[2] } : undefined;
}
