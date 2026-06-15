import chalk from "chalk";
import * as clack from "@clack/prompts";

/**
 * Terminal output controller (singleton). One object owns the output
 * format (interactive clack UI vs machine-readable porcelain) and the
 * verbosity; the CLI talks through it so every command renders
 * consistently and scripts/CI never hang.
 *
 * Modes (format):
 *   interactive  (default)     clack: gutter, spinners, prompts
 *   porcelain    --porcelain   tab-separated `<level>\t<message>` lines
 *
 * Verbosity (orthogonal):
 *   normal  spinners + messages + prompts
 *   quiet   -q          only the final summary line + errors; prompts auto-default
 *   silent  --silent    errors to stderr only; prompts auto-default
 *
 * Non-TTY output (piped/redirected, no flag) degrades spinners to plain
 * lines — clack only drops its cursor animation under CI=true, so without
 * this a piped run spews escape codes.
 *
 * `log()` is the bare data path (e.g. `pushwork url`): plain stdout in
 * every mode, suppressed only by --silent.
 */

export type Verbosity = "normal" | "quiet" | "silent";

export interface OutputConfig {
	porcelain?: boolean;
	verbosity?: Verbosity;
}

export interface SelectOption<T> {
	value: T;
	label: string;
	hint?: string;
}

export class Output {
	private static instance: Output | null = null;

	private porcelain = false;
	private verbosity: Verbosity = "normal";
	private spinner: ReturnType<typeof clack.spinner> | null = null;
	private taskStart: number | null = null;
	private taskMessage = "";
	private introShown = false;

	private constructor() {}

	static getInstance(): Output {
		if (!Output.instance) Output.instance = new Output();
		return Output.instance;
	}

	configure(config: OutputConfig): void {
		if (config.porcelain !== undefined) this.porcelain = config.porcelain;
		if (config.verbosity !== undefined) this.verbosity = config.verbosity;
	}

	get isPorcelain(): boolean {
		return this.porcelain;
	}
	get isQuiet(): boolean {
		return this.verbosity !== "normal";
	}
	get isSilent(): boolean {
		return this.verbosity === "silent";
	}

	/** Whether a prompt can actually be asked (else callers must default). */
	get isInteractive(): boolean {
		return (
			!this.porcelain &&
			!this.isQuiet &&
			Boolean(process.stdout.isTTY) &&
			Boolean(process.stdin.isTTY)
		);
	}

	private get isTTY(): boolean {
		return Boolean(process.stdout.isTTY);
	}

	/** Normal verbosity but not a TTY: render spinners as plain lines. */
	private get plain(): boolean {
		return !this.porcelain && !this.isQuiet && !this.isTTY;
	}

	// ── Lifecycle (intro / outro) ────────────────────────────────────────

	intro(title: string): void {
		if (this.porcelain || this.isQuiet) return;
		if (!this.isTTY) return;
		clack.intro(chalk.inverse(` ${title} `));
		this.introShown = true;
	}

	/** Closing line. Quiet prints a plain summary; silent/porcelain suppress. */
	outro(message: string): void {
		// Complete the final phase so its line persists, then frame the close.
		if (this.taskStart != null) this.done();
		this.halt();
		if (this.isSilent || this.porcelain) return;
		if (this.isQuiet) {
			if (message) console.log(strip(message));
			return;
		}
		if (this.plain) {
			console.log(message);
			return;
		}
		if (this.introShown) {
			clack.outro(message);
			this.introShown = false;
		} else {
			clack.log.success(message);
		}
	}

	// ── Task (spinner) ───────────────────────────────────────────────────

	task(message: string): void {
		if (this.spinner) this.done();
		this.taskStart = Date.now();
		this.taskMessage = message;
		// Only an interactive TTY shows a live spinner; porcelain/plain/quiet
		// render one completion line per phase (via done()) instead, so the
		// phase log isn't doubled (start + done) or animated into a pipe.
		if (this.isQuiet || this.porcelain || this.plain) return;
		this.spinner = clack.spinner();
		this.spinner.start(message);
	}

	/**
	 * Advance to a new phase: complete the current one (leaving its line),
	 * then start the next. This is the per-phase reporter the library calls
	 * during long operations, so each phase persists with its own timing.
	 */
	step(message: string): void {
		this.done();
		this.task(message);
	}

	done(message?: string, showTime = true): void {
		if (this.taskStart == null) return;
		let text = message ?? this.taskMessage ?? "done";
		if (showTime) text += chalk.dim(` (${fmtMs(Date.now() - this.taskStart)})`);
		if (this.spinner) {
			this.spinner.stop(text);
			this.spinner = null;
		} else if (this.porcelain && !this.isQuiet) {
			console.log(`ok\t${strip(text)}`);
		} else if (this.plain) {
			console.log(text);
		}
		this.taskStart = null;
	}

	// ── Plain + leveled output ───────────────────────────────────────────

	/** Bare stdout line — the data path. Suppressed only by --silent. */
	log(message: string): void {
		if (this.isSilent) return;
		this.halt();
		console.log(message);
	}

	info(message: string): void {
		if (this.isQuiet) return;
		this.halt();
		if (this.porcelain) console.log(`info\t${message}`);
		else if (this.plain) console.log(message);
		else clack.log.info(message);
	}

	success(message: string): void {
		if (this.isQuiet) return;
		this.halt();
		if (this.porcelain) console.log(`ok\t${message}`);
		else if (this.plain) console.log(message);
		else clack.log.success(message);
	}

	warn(message: string): void {
		if (this.isSilent) {
			console.error(`warning: ${message}`);
			return;
		}
		if (this.isQuiet) return;
		this.halt();
		if (this.porcelain) console.log(`warning\t${message}`);
		else if (this.plain) console.log(`warning: ${message}`);
		else clack.log.warn(message);
	}

	error(message: unknown): void {
		const text = message instanceof Error ? message.message : String(message);
		if (this.spinner) {
			this.spinner.error(chalk.red("failed"));
			this.spinner = null;
			this.taskStart = null;
		}
		if (this.isSilent) {
			console.error(`error: ${text}`);
			return;
		}
		if (this.porcelain) {
			console.log(`error\t${text}`);
			return;
		}
		if (this.plain) {
			console.error(`error: ${text}`);
			return;
		}
		clack.log.error(chalk.red(text));
	}

	// ── Structured data ──────────────────────────────────────────────────

	/** Key-value rows. Porcelain: `key\tvalue` lines. Quiet/silent: suppressed. */
	obj(record: Record<string, unknown>): void {
		if (this.isQuiet) return;
		this.halt();
		const entries = Object.entries(record).filter(([, v]) => v !== undefined);
		if (entries.length === 0) return;
		if (this.porcelain) {
			for (const [k, v] of entries) console.log(`${k}\t${String(v)}`);
			return;
		}
		const pad = Math.max(...entries.map(([k]) => k.length));
		const rows = entries
			.map(([k, v]) => `${chalk.dim(k.padEnd(pad + 2))}${String(v)}`)
			.join("\n");
		if (this.introShown) clack.log.message(rows);
		else console.log(rows);
	}

	/**
	 * Highlighted banner (e.g. a final "CLONED <url>" line). Porcelain emits
	 * `ok\t<label>\t<message>`; quiet/silent suppress.
	 */
	block(label: string, message = ""): void {
		if (this.isSilent) return;
		this.halt();
		if (this.porcelain) {
			console.log(`ok\t${label}${message && `\t${message}`}`);
			return;
		}
		// Quiet shows the result banner (its one summary line); non-TTY plain.
		if (this.isQuiet || this.plain) {
			console.log(`${label}${message && ` ${message}`}`);
			return;
		}
		const banner = `${chalk.bgCyan.black(` ${label} `)}${message && ` ${message}`}`;
		if (this.introShown) clack.log.message(banner);
		else console.log(banner);
	}

	/** Bulleted list. Porcelain/non-interactive: plain lines. */
	arr(items: string[]): void {
		if (this.isQuiet) return;
		this.halt();
		for (const item of items) {
			console.log(this.porcelain || !this.isTTY ? item : `${chalk.dim("•")} ${item}`);
		}
	}

	// ── Prompts ──────────────────────────────────────────────────────────

	/** Yes/no. Returns `def` without asking when non-interactive. Ctrl-C → 130. */
	async confirm(question: string, def: boolean): Promise<boolean> {
		if (!this.isInteractive) return def;
		this.halt();
		const answer = await clack.confirm({message: question, initialValue: def});
		if (clack.isCancel(answer)) {
			clack.cancel("Cancelled.");
			process.exit(130);
		}
		return answer;
	}

	/**
	 * Single-choice menu. Throws in non-interactive mode (the caller has no
	 * sensible default for a required choice). Ctrl-C → 130.
	 */
	async select<T>(question: string, options: SelectOption<T>[]): Promise<T> {
		if (!this.isInteractive) {
			throw new Error(
				`cannot prompt for "${question}" without an interactive terminal`,
			);
		}
		this.halt();
		// `Option<Value>` is a conditional type that won't resolve for an
		// unconstrained generic; the runtime shape ({value,label,hint}) is
		// correct, so cast past the check.
		const answer = await clack.select<T>({
			message: question,
			options: options as never,
		});
		if (clack.isCancel(answer)) {
			clack.cancel("Cancelled.");
			process.exit(130);
		}
		return answer as T;
	}

	exit(code = 0): never {
		this.halt();
		process.exit(code);
	}

	/** Erase any live spinner without printing a completion line. */
	private halt(): void {
		if (this.spinner) {
			this.spinner.clear();
			this.spinner = null;
		}
		this.taskStart = null;
	}
}

const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

const fmtMs = (ms: number): string =>
	ms < 1000
		? `${ms}ms`
		: ms < 2000
			? `${(ms / 1000).toFixed(2)}s`
			: `${(ms / 1000).toFixed(1)}s`;

export const out = Output.getInstance();
