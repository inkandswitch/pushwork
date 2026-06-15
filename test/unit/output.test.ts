/**
 * Output mode behavior (src/utils/output.ts).
 *
 * The Output singleton is the contract between every command and the
 * terminal: interactive (clack) vs porcelain (tab-separated wire format),
 * crossed with normal/quiet/silent verbosity. Scripts parse the porcelain
 * format and the bare `log()` data path (`pushwork url | ...`), so these
 * are compatibility surfaces, not cosmetics.
 */

import { Output } from "../../src/utils/output";

type Line = { stream: "stdout" | "stderr"; text: string };

let lines: Line[];
let logSpy: jest.SpyInstance;
let errSpy: jest.SpyInstance;

function stdout(): string[] {
	return lines.filter((l) => l.stream === "stdout").map((l) => l.text);
}
function stderr(): string[] {
	return lines.filter((l) => l.stream === "stderr").map((l) => l.text);
}

beforeEach(() => {
	Output.reset();
	lines = [];
	logSpy = jest
		.spyOn(console, "log")
		.mockImplementation((...args: unknown[]) => {
			lines.push({ stream: "stdout", text: args.map(String).join(" ") });
		});
	errSpy = jest
		.spyOn(console, "error")
		.mockImplementation((...args: unknown[]) => {
			lines.push({ stream: "stderr", text: args.map(String).join(" ") });
		});
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	Output.reset();
});

function configured(config: Parameters<Output["configure"]>[0]): Output {
	const out = Output.getInstance();
	out.configure(config);
	return out;
}

describe("porcelain wire format", () => {
	it("emits <level>\\t<message> lines", () => {
		const out = configured({ porcelain: true });
		out.info("scanning");
		out.success("all good");
		out.warn("careful");
		out.error("broke");

		expect(stdout()).toEqual([
			"info\tscanning",
			"ok\tall good",
			"warning\tcareful",
			"error\tbroke",
		]);
	});

	it("task lifecycle emits info on start and ok on completion", () => {
		const out = configured({ porcelain: true });
		out.task("Syncing");
		out.taskLine("detail line");
		out.done("Synced", false);

		expect(stdout()).toEqual(["info\tSyncing", "info\tdetail line", "ok\tSynced"]);
	});

	it("blocks become level-tagged lines and obj becomes key\\tvalue", () => {
		const out = configured({ porcelain: true });
		out.successBlock("SYNCED", "3 files");
		out.obj({ Path: "/tmp/x", Files: 3 });

		expect(stdout()).toEqual(["ok\tSYNCED\t3 files", "Path\t/tmp/x", "Files\t3"]);
	});

	it("contains no ANSI escape codes", () => {
		const out = configured({ porcelain: true });
		out.successBlock("SYNCED", "3 files");
		out.done();
		// eslint-disable-next-line no-control-regex
		const ansi = /\u001b\[/;
		for (const line of stdout()) expect(line).not.toMatch(ansi);
	});
});

describe("bare data path (log)", () => {
	it("prints unmodified in every mode except silent", () => {
		const url = "automerge:2aVYghgKqy3t6d1YT77CoqZwAVVn";

		for (const config of [
			{ porcelain: false, verbosity: "normal" as const },
			{ porcelain: true, verbosity: "normal" as const },
			{ porcelain: false, verbosity: "quiet" as const },
		]) {
			lines = [];
			Output.reset();
			configured(config).log(url);
			expect(stdout()).toEqual([url]);
		}

		lines = [];
		Output.reset();
		configured({ verbosity: "silent" }).log(url);
		expect(stdout()).toEqual([]);
	});
});

describe("quiet mode", () => {
	it("suppresses progress and detail but shows summaries", () => {
		// (Errors in quiet+interactive mode render via clack, which is
		// mocked in unit tests; the error path is asserted in the
		// porcelain and silent suites.)
		const out = configured({ verbosity: "quiet" });
		out.task("Syncing");
		out.taskLine("noise");
		out.update("more noise");
		out.info("info noise");
		out.done("Synced");
		out.successBlock("SYNCED", "3 files");

		expect(stdout()).toEqual(["SYNCED 3 files"]);
	});
});

describe("silent mode", () => {
	it("emits nothing on stdout; errors and warnings go to stderr", () => {
		const out = configured({ verbosity: "silent" });
		out.task("Syncing");
		out.done("Synced");
		out.successBlock("SYNCED", "3 files");
		out.info("hi");
		out.warn("careful");
		out.error("broke");

		expect(stdout()).toEqual([]);
		expect(stderr()).toEqual(["warning: careful", "error: broke"]);
	});
});

describe("progress", () => {
	it("porcelain: emits progress line on start and ok on stop", () => {
		const out = configured({ porcelain: true });
		const bar = out.progress("Uploading 3 documents", 3);
		bar.advance(1);
		bar.advance(2);
		bar.stop("Uploaded 3 documents", false);

		expect(stdout()).toEqual([
			"progress\tUploading 3 documents\t3",
			"ok\tUploaded 3 documents",
		]);
	});

	it("porcelain: fail emits an error line", () => {
		const out = configured({ porcelain: true });
		const bar = out.progress("Uploading", 2);
		bar.fail("1 of 2 failed");

		expect(stdout()).toEqual(["progress\tUploading\t2", "error\t1 of 2 failed"]);
	});

	it("quiet/silent: fully suppressed, handle is safe to drive", () => {
		for (const verbosity of ["quiet", "silent"] as const) {
			lines = [];
			Output.reset();
			const bar = configured({ verbosity }).progress("Uploading", 5);
			bar.advance(5);
			bar.stop();
			expect(stdout()).toEqual([]);
		}
	});

	it("stop is idempotent and advance after stop is a no-op", () => {
		const out = configured({ porcelain: true });
		const bar = out.progress("Working", 2);
		bar.stop("Done", false);
		bar.stop("Done again", false);
		bar.advance(1);

		expect(stdout()).toEqual(["progress\tWorking\t2", "ok\tDone"]);
	});

	it("a live interactive bar survives an in-loop taskLine (not dismissed)", () => {
		// In interactive (TTY) mode a progress bar owns the live region. An
		// out.taskLine() with no spinner task active used to fall through to
		// info() → finalizeSpinner() → dismiss the bar, so every later
		// advance()/stop() became a no-op and the closing summary never
		// printed (push deletions/moves/artifact rebuilds hit this). taskLine
		// must now route through the bar instead. This is Output-side logic
		// independent of clack's rendering, so we force TTY and stub
		// process.stdout.write so the real clack bar doesn't paint.
		const origTTY = process.stdout.isTTY;
		Object.defineProperty(process.stdout, "isTTY", {
			value: true,
			configurable: true,
		});
		const writeSpy = jest
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		try {
			const out = configured({}); // normal + non-porcelain + TTY ⇒ live bar
			const bar = out.progress("Pushing 3 changes", 3);
			expect(bar.isStopped).toBe(false);
			out.taskLine("Removed foo.txt from root"); // would dismiss pre-fix
			expect(bar.isStopped).toBe(false); // bar survived
			bar.stop("Pushed 3 files");
			expect(bar.isStopped).toBe(true);
		} finally {
			writeSpy.mockRestore();
			Object.defineProperty(process.stdout, "isTTY", {
				value: origTTY,
				configurable: true,
			});
		}
	});
});

describe("plain mode (normal verbosity, non-TTY)", () => {
	// Tests run piped (process.stdout.isTTY is falsy), so the default
	// (normal, non-porcelain) config is the plain path: spinners and bars
	// degrade to plain lines instead of clack's cursor-animated regions.
	// This is what makes `pushwork sync | tee log` clean for scripting.
	const ttyOnly = process.stdout.isTTY
		? it.skip
		: it;

	ttyOnly("renders task + progress as plain lines, no escape codes", () => {
		const out = configured({});
		out.task("Detecting changes");
		out.taskLine("a detail");
		out.done("Detected 3 documents", false);
		const bar = out.progress("Cloning 5 files", 5);
		bar.advance(2, "Cloning 2/5 files");
		bar.stop("Cloned 5/5 files", false);

		const text = stdout().join("\n");
		// The whole point: no ANSI/cursor escape sequences in piped output.
		// eslint-disable-next-line no-control-regex
		expect(text).not.toMatch(/\u001b\[/);
		expect(stdout()).toEqual([
			"Detecting changes",
			"  a detail",
			"Detected 3 documents",
			"Cloning 5 files",
			"Cloned 5/5 files",
		]);
	});
});

describe("confirm", () => {
	it("returns the default without prompting when not interactive", async () => {
		// Tests run piped (no TTY), and porcelain/quiet force non-interactive
		// anyway — confirm must resolve immediately with the default.
		await expect(
			configured({ porcelain: true }).confirm("Overwrite?", false)
		).resolves.toBe(false);
		Output.reset();
		await expect(
			configured({ verbosity: "quiet" }).confirm("Overwrite?", true)
		).resolves.toBe(true);
	});
});
