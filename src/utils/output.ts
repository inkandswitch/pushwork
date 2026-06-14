import chalk from "chalk";
import * as clack from "@clack/prompts";

/**
 * Terminal output manager (singleton), modeled on darn's `Output`
 * controller: one object owns the format (interactive clack UI vs
 * machine-readable porcelain) and the verbosity, and every command
 * talks through it.
 *
 * # Modes
 *
 * | Mode          | Flag          | Rendering                                  |
 * |---------------|---------------|--------------------------------------------|
 * | interactive   | (default)     | @clack/prompts: gutter, spinners, prompts  |
 * | porcelain     | `--porcelain` | tab-separated `<level>\t<message>` lines   |
 *
 * # Porcelain wire format
 *
 * | Prefix    | Emitted by                              |
 * |-----------|------------------------------------------|
 * | `ok`      | success, blocks, task completion         |
 * | `error`   | error, errorBlock                        |
 * | `warning` | warn, warnBlock                          |
 * | `info`    | info, task start, taskLine, spicy        |
 *
 * Structured data (`obj`) is `<key>\t<value>` with no level prefix.
 * `log()` is the bare data path (e.g. `pushwork url`) — always plain,
 * never decorated, in every mode.
 *
 * # Verbosity (orthogonal to format)
 *
 * | Level  | Spinners/detail | Summaries (blocks) | Errors | Prompts      |
 * |--------|-----------------|--------------------|--------|--------------|
 * | normal | yes             | yes                | yes    | interactive  |
 * | quiet  | no              | plain line         | yes    | auto-default |
 * | silent | no              | no                 | stderr | auto-default |
 *
 * Prompts also auto-accept their default when stdin/stdout isn't a TTY,
 * so scripts and CI never hang on a question.
 */

export type Verbosity = "normal" | "quiet" | "silent";

export interface OutputConfig {
  porcelain?: boolean;
  verbosity?: Verbosity;
}

export class Output {
  private static instance: Output | null = null;

  private porcelain = false;
  private verbosity: Verbosity = "normal";

  private spinner: ReturnType<typeof clack.spinner> | null = null;
  private taskStartTime: number | null = null;
  private taskOriginalMessage: string | null = null;
  private taskCurrentMessage: string | null = null;
  private taskLines: string[] = [];
  private taskMaxLines = 0;
  private introShown = false;

  private constructor() {}

  static getInstance(): Output {
    if (!Output.instance) {
      Output.instance = new Output();
    }
    return Output.instance;
  }

  /** Reset the singleton (useful for testing) */
  static reset(): void {
    Output.instance?.haltSpinner();
    Output.instance = null;
  }

  // ── Mode control ─────────────────────────────────────────────────────

  configure(config: OutputConfig): void {
    if (config.porcelain !== undefined) this.porcelain = config.porcelain;
    if (config.verbosity !== undefined) this.verbosity = config.verbosity;
  }

  get isPorcelain(): boolean {
    return this.porcelain;
  }

  get isQuiet(): boolean {
    return this.verbosity === "quiet" || this.verbosity === "silent";
  }

  get isSilent(): boolean {
    return this.verbosity === "silent";
  }

  /** Whether prompts can actually be asked. */
  get isInteractive(): boolean {
    return (
      !this.porcelain &&
      !this.isQuiet &&
      Boolean(process.stdout.isTTY) &&
      Boolean(process.stdin.isTTY)
    );
  }

  /** Interactive clack rendering (vs porcelain wire format). */
  private get clackMode(): boolean {
    return !this.porcelain;
  }

  /** Whether stdout is a real terminal (vs a pipe/file/CI). */
  private get isTTY(): boolean {
    return Boolean(process.stdout.isTTY);
  }

  /**
   * Plain, line-based rendering: normal verbosity but stdout isn't a TTY
   * (piped/redirected for scripting). clack only drops its animated
   * spinners/bars under `CI=true`, so without this a piped `pushwork sync`
   * spews cursor-animation escape codes. Leveled output (info/success) is
   * still fine — only the live spinner/bar regions degrade to plain lines.
   */
  private get plain(): boolean {
    return this.clackMode && !this.isQuiet && !this.isTTY;
  }

  // ── Lifecycle (intro/outro) ──────────────────────────────────────────

  /** Command header. Suppressed in porcelain/quiet/silent. */
  intro(title: string): void {
    if (!this.clackMode || this.isQuiet) return;
    clack.intro(chalk.inverse(` ${title} `));
    this.introShown = true;
  }

  /**
   * Command footer. Quiet mode prints a plain summary line (that line is
   * what quiet mode exists to show); silent and porcelain suppress.
   */
  outro(message: string): void {
    this.finalizeSpinner();
    if (this.isSilent || this.porcelain) return;
    if (this.isQuiet) {
      if (message) console.log(stripAnsi(message));
      return;
    }
    if (this.introShown) {
      clack.outro(message);
      this.introShown = false;
    } else {
      clack.log.success(message);
    }
  }

  // ── Tasks (spinner + scrolling detail lines) ─────────────────────────

  /**
   * Start a task with a spinner. Completes any previous task first.
   * @param maxLines max scrolling detail lines below the spinner (0 = unlimited)
   */
  task(message: string, maxLines = 0): void {
    if (this.spinner) this.done();

    this.taskStartTime = Date.now();
    this.taskOriginalMessage = message;
    this.taskCurrentMessage = message;
    this.taskMaxLines = maxLines;
    this.taskLines = [];

    if (this.isQuiet) return;
    if (this.porcelain) {
      console.log(`info\t${message}`);
      return;
    }
    if (this.plain) {
      // Non-TTY: no animated spinner — print the task line once.
      console.log(message);
      return;
    }
    this.spinner = clack.spinner();
    this.spinner.start(message);
  }

  /** Update the active task's message in place. */
  update(message: string): void {
    this.taskCurrentMessage = message;
    this.renderTask();
  }

  /**
   * Add a detail line under the active task (scrolls when maxLines is
   * set). Lines vanish on completion unless `keepOnComplete`. Falls back
   * to `info()` when no task is active.
   */
  taskLine(message: string, keepOnComplete = false): void {
    if (!this.taskStartTime) {
      this.info(message);
      return;
    }
    if (this.porcelain && !this.isQuiet) {
      console.log(`info\t${message}`);
    } else if (this.plain) {
      console.log(`  ${message}`);
    }
    this.taskLines.push(keepOnComplete ? `[keep]${message}` : message);
    if (this.taskMaxLines > 0 && this.taskLines.length > this.taskMaxLines) {
      this.taskLines = this.taskLines.slice(-this.taskMaxLines);
    }
    this.renderTask();
  }

  clearTaskLines(): void {
    this.taskLines = [];
    this.renderTask();
  }

  private renderTask(): void {
    if (!this.spinner) return;
    const head = this.taskCurrentMessage ?? "";
    const detail = this.taskLines
      .map((l) => chalk.dim(`  ${l.startsWith("[keep]") ? l.slice(6) : l}`))
      .join("\n");
    this.spinner.message(detail ? `${head}\n${detail}` : head);
  }

  /** Complete the task, showing duration by default. */
  done(message?: string, showTime = true): void {
    if (!this.taskStartTime) return;

    let text = message || this.taskOriginalMessage || "done";
    if (showTime && this.taskStartTime) {
      const ms = Date.now() - this.taskStartTime;
      const dur =
        ms < 1000
          ? `${ms}ms`
          : ms < 2000
            ? `${(ms / 1000).toFixed(2)}s`
            : `${(ms / 1000).toFixed(1)}s`;
      text += chalk.dim(` (${dur})`);
    }

    const kept = this.taskLines
      .filter((l) => l.startsWith("[keep]"))
      .map((l) => l.slice(6));

    if (this.spinner) {
      this.spinner.stop(text);
      this.spinner = null;
      for (const line of kept) clack.log.message(chalk.dim(line));
    } else if (this.porcelain && !this.isQuiet) {
      console.log(`ok\t${stripAnsi(text)}`);
      for (const line of kept) console.log(`info\t${line}`);
    } else if (this.plain) {
      // kept detail lines were already printed by taskLine() in plain mode
      console.log(text);
    }

    this.resetTaskState();
  }

  // ── Plain + leveled output ───────────────────────────────────────────

  /**
   * Bare line on stdout — the data path (`url`, `ls`, `diff` listings).
   * Never decorated, identical in interactive and porcelain modes;
   * suppressed only by `--silent`.
   */
  log(
    message: string,
    color?:
      | "red"
      | "green"
      | "yellow"
      | "blue"
      | "cyan"
      | "magenta"
      | "gray"
      | "dim"
  ): void {
    if (this.isSilent) return;
    this.finalizeSpinner();
    if (color && this.clackMode) {
      const colorFn = color === "dim" ? chalk.dim : chalk[color];
      console.log(colorFn(message));
    } else {
      console.log(message);
    }
  }

  /** Informational message. Suppressed in quiet/silent. */
  info(message: string): void {
    if (this.isQuiet) return;
    this.finalizeSpinner();
    if (this.porcelain) console.log(`info\t${message}`);
    else clack.log.info(message);
  }

  /** Success message. Suppressed in quiet/silent. */
  success(message: string): void {
    if (this.isQuiet) return;
    this.finalizeSpinner();
    if (this.porcelain) console.log(`ok\t${message}`);
    else clack.log.success(message);
  }

  /** Warning. Quiet suppresses; silent diverts to stderr. */
  warn(message: string): void {
    if (this.isSilent) {
      console.error(`warning: ${message}`);
      return;
    }
    if (this.isQuiet) return;
    this.finalizeSpinner();
    if (this.porcelain) console.log(`warning\t${message}`);
    else clack.log.warn(message);
  }

  /** Error. Always shown; silent diverts to stderr. Fails the spinner. */
  error(message: string | Error | unknown): void {
    const text =
      message instanceof Error
        ? message.message
        : message instanceof Object
          ? JSON.stringify(message)
          : String(message);

    if (this.spinner) {
      this.spinner.error(chalk.red("failed"));
      this.spinner = null;
      this.resetTaskState();
    }
    if (this.isSilent) {
      console.error(`error: ${text}`);
      return;
    }
    if (this.porcelain) console.log(`error\t${text}`);
    else clack.log.error(chalk.red(text));
  }

  // ── Blocks (final summaries) ─────────────────────────────────────────
  // Shown as labeled banners interactively, `<level>\t` lines in
  // porcelain, plain lines in quiet (the one thing quiet shows), and
  // suppressed in silent (except errorBlock → stderr).

  successBlock(label: string, message = ""): void {
    this.block("ok", chalk.bgGreen.black, label, message);
  }

  infoBlock(label: string, message = ""): void {
    this.block("info", chalk.bgGrey.white, label, message);
  }

  warnBlock(label: string, message = ""): void {
    this.block("warning", chalk.bgYellow.black, label, message);
  }

  errorBlock(label: string, message = ""): void {
    if (this.spinner) {
      this.spinner.error(chalk.red("failed"));
      this.spinner = null;
      this.resetTaskState();
    }
    if (this.isSilent) {
      console.error(`error: ${label}${message && ` ${message}`}`);
      return;
    }
    if (this.porcelain) {
      console.log(`error\t${label}${message && `\t${message}`}`);
      return;
    }
    console.error(
      `\n${chalk.bgRed.white(` ${label} `)}${message && ` ${message}`}`
    );
  }

  spicyBlock(label: string, message = ""): void {
    this.block("info", chalk.bgCyan.black, label, message);
  }

  private block(
    level: "ok" | "info" | "warning",
    style: (s: string) => string,
    label: string,
    message: string
  ): void {
    this.finalizeSpinner();
    if (this.isSilent) return;
    if (this.porcelain) {
      console.log(`${level}\t${label}${message && `\t${message}`}`);
      return;
    }
    if (this.isQuiet) {
      console.log(`${label}${message && ` ${message}`}`);
      return;
    }
    const banner = `${style(` ${label} `)}${message && ` ${message}`}`;
    if (this.introShown) {
      clack.log.message(banner);
    } else {
      console.log(`\n${banner}`);
    }
  }

  // ── Structured data ──────────────────────────────────────────────────

  /** Key-value table. Porcelain: `key\tvalue` lines. Quiet/silent: suppressed. */
  obj(
    obj: Record<string, any>,
    keyTransform?: (key: string) => string,
    valueTransform?: (value: any, key: string) => string
  ): void {
    if (this.isQuiet) return;
    this.finalizeSpinner();

    const entries: Array<[string, string, any]> = [];
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue;
      entries.push([key, keyTransform ? keyTransform(key) : key, value]);
    }
    if (entries.length === 0) return;

    if (this.porcelain) {
      for (const [key, displayKey, value] of entries) {
        const v = valueTransform ? valueTransform(value, key) : String(value);
        console.log(`${displayKey}\t${stripAnsi(v)}`);
      }
      return;
    }

    const pad = Math.max(...entries.map(([, k]) => k.length));
    const rows = entries.map(([key, displayKey, value]) => {
      const v = valueTransform ? valueTransform(value, key) : String(value);
      return `${chalk.dim(displayKey.padEnd(pad + 2))}${v}`;
    });
    if (this.introShown) {
      clack.log.message(rows.join("\n"));
    } else {
      for (const row of rows) console.log(row);
    }
  }

  /** Bulleted list. Porcelain: plain lines. Quiet/silent: suppressed. */
  arr(items: any[]): void {
    if (this.isQuiet) return;
    this.finalizeSpinner();
    for (const item of items) {
      console.log(
        this.porcelain ? String(item) : `${chalk.dim("• ")}${String(item)}`
      );
    }
  }

  // ── Flair ────────────────────────────────────────────────────────────

  spicy(message: string): void {
    if (this.isQuiet) return;
    this.finalizeSpinner();
    if (this.porcelain) console.log(`info\t${message}`);
    else console.log(chalk.cyan(message));
  }

  rainbow(message: string): void {
    if (this.isQuiet) return;
    this.finalizeSpinner();
    if (this.porcelain) {
      console.log(`info\t${message}`);
      return;
    }
    const colors = [
      chalk.red,
      chalk.rgb(255, 165, 0),
      chalk.yellow,
      chalk.green,
      chalk.cyan,
      chalk.blue,
      chalk.magenta,
    ];
    console.log(
      message
        .split("")
        .map((c, i) =>
          colors[
            Math.min(
              Math.floor((i / message.length) * colors.length),
              colors.length - 1
            )
          ](c)
        )
        .join("")
    );
  }

  // ── Progress bars ────────────────────────────────────────────────────

  /**
   * Start a determinate progress bar (one live region: any active
   * spinner is cleared first, and starting a task clears the bar).
   *
   * Porcelain emits `progress\t<message>\t<total>` on start and
   * `ok\t<message>` on stop. Quiet/silent return a no-op handle.
   */
  progress(message: string, total: number): Progress {
    this.finalizeSpinner(); // also dismisses any previous bar

    const startTime = Date.now();
    if (this.isQuiet) {
      return new Progress(null, null, startTime);
    }
    if (this.porcelain) {
      console.log(`progress\t${message}\t${total}`);
      return new Progress(null, message, startTime);
    }
    if (this.plain) {
      // Non-TTY: no animated bar — print the start line; stop() prints the
      // completion line. advance() is a no-op.
      console.log(message);
      return new Progress(null, message, startTime, true);
    }
    const bar = clack.progress({ max: total, style: "heavy" });
    bar.start(message);
    const handle = new Progress(bar, message, startTime);
    this.activeProgress = handle;
    return handle;
  }

  private activeProgress: Progress | null = null;

  // ── Prompts ──────────────────────────────────────────────────────────

  /**
   * Yes/no question. Returns `defaultValue` without asking when not
   * interactive (porcelain, quiet, silent, or no TTY), so scripts and CI
   * never hang. Ctrl-C exits 130.
   */
  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    if (!this.isInteractive) return defaultValue;
    this.finalizeSpinner();
    const answer = await clack.confirm({
      message: question,
      initialValue: defaultValue,
    });
    if (clack.isCancel(answer)) {
      clack.cancel("Cancelled.");
      process.exit(130);
    }
    return answer;
  }

  // ── Fatal paths ──────────────────────────────────────────────────────

  /** Print error (+ stack) and exit. */
  crash(error: unknown, exitCode = 1): never {
    this.haltSpinner();
    if (error instanceof Error) {
      console.error(chalk.red(`${error.name}: ${error.message}`));
      if (error.stack) {
        console.error("");
        console.error(chalk.dim("Stack trace:"));
        for (const line of error.stack.split("\n").slice(1)) {
          console.error(chalk.dim(`  ${line.trim()}`));
        }
      }
    } else {
      console.error(chalk.red(String(error)));
    }
    process.exit(exitCode);
  }

  exit(code?: number): never {
    this.haltSpinner();
    process.exit(code || 0);
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Stray output while a task or bar is live clears it invisibly
   * (same semantics the ora-based implementation had). A dismissed
   * Progress handle becomes a no-op for later advance/stop calls.
   */
  private finalizeSpinner(): void {
    this.haltSpinner();
  }

  /** Erase the live spinner/bar without printing a completion line. */
  private haltSpinner(): void {
    if (this.spinner) {
      this.spinner.clear();
      this.spinner = null;
    }
    if (this.activeProgress) {
      this.activeProgress.dismiss();
      this.activeProgress = null;
    }
    this.resetTaskState();
  }

  private resetTaskState(): void {
    this.taskStartTime = null;
    this.taskOriginalMessage = null;
    this.taskCurrentMessage = null;
    this.taskLines = [];
    this.taskMaxLines = 0;
  }
}

/**
 * Handle returned by {@link Output.progress}. A null bar means the mode
 * doesn't render one (porcelain printed its wire line at start; quiet and
 * silent print nothing) — `advance` is then a no-op and `stop` emits the
 * porcelain completion line when applicable.
 */
export class Progress {
  private stopped = false;

  constructor(
    private readonly bar: ReturnType<typeof clack.progress> | null,
    private readonly porcelainMessage: string | null,
    private readonly startTime: number,
    // Non-TTY plain mode: stop()/fail() print a plain line (not a `tab`
    // porcelain record). advance() is still a no-op (no live bar).
    private readonly plain = false
  ) {}

  advance(step = 1, message?: string): void {
    if (this.stopped) return;
    this.bar?.advance(step, message);
  }

  stop(message?: string, showTime = true): void {
    if (this.stopped) return;
    this.stopped = true;

    let text = message ?? this.porcelainMessage ?? "done";
    if (showTime) {
      const ms = Date.now() - this.startTime;
      const dur =
        ms < 1000
          ? `${ms}ms`
          : ms < 2000
            ? `${(ms / 1000).toFixed(2)}s`
            : `${(ms / 1000).toFixed(1)}s`;
      text += chalk.dim(` (${dur})`);
    }

    if (this.bar) {
      this.bar.stop(text);
    } else if (this.plain) {
      console.log(text);
    } else if (this.porcelainMessage !== null) {
      console.log(`ok\t${stripAnsi(text)}`);
    }
  }

  /** Mark the bar as failed (interactive); porcelain emits an error line. */
  fail(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.bar) {
      this.bar.error(message);
    } else if (this.plain) {
      console.log(message);
    } else if (this.porcelainMessage !== null) {
      console.log(`error\t${message}`);
    }
  }

  /** Erase without any completion output; later calls become no-ops. */
  dismiss(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.bar?.clear();
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Global singleton output instance. */
export const out = Output.getInstance();
