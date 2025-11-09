import chalk from "chalk";
import ora, { Ora } from "ora";

/**
 * Clean terminal output manager
 * - Progress stays on one line (spinner updates in place)
 * - No emojis
 * - Background colors for section headers
 * - Minimal output
 */
export class Output {
  private spinner: Ora | null = null;
  private quiet: boolean = false;
  private taskStartTime: number | null = null;
  private taskMessage: string | null = null;

  constructor(quiet = false) {
    this.quiet = quiet;
  }

  /**
   * Start a task with spinner - updates in place
   */
  task(message: string): void {
    if (this.quiet) return;
    this.#stopTask();
    this.taskStartTime = Date.now();
    this.taskMessage = message;
    this.spinner = ora(message).start();
  }

  /**
   * Update spinner text (stays on same line)
   */
  update(message: string): void {
    if (this.spinner && !this.quiet) {
      this.spinner.text = message;
    }
  }

  /**
   * Complete task with optional duration display
   * Defaults to showing the original task message with duration
   */
  done(message?: string, showTime: boolean = true): void {
    if (this.quiet) return;

    let text = message || this.taskMessage || "done";
    if (showTime && this.taskStartTime) {
      const duration = ((Date.now() - this.taskStartTime) / 1000).toFixed(1);
      text += ` (${duration}s)`;
    }

    if (this.spinner) {
      this.spinner.succeed(text);
      this.spinner = null;
    }
    this.taskStartTime = null;
    this.taskMessage = null;
  }

  /**
   * Show a banner header with background color
   */
  banner(
    type: "success" | "error" | "warning" | "info",
    message: string
  ): void {
    if (this.quiet) return;
    this.#stopTask();

    const label = type.toUpperCase();
    let styled: string;

    switch (type) {
      case "success":
        styled = chalk.bgGreen.black(label);
        break;
      case "error":
        styled = chalk.bgRed.white(label);
        break;
      case "warning":
        styled = chalk.bgYellow.black(label);
        break;
      case "info":
        styled = chalk.bgGrey.white(label);
        break;
      default:
        styled = chalk.bgWhite.black(label);
    }

    console.log(`\n${styled} ${message}`);
  }

  /**
   * Show a key-value pair (indented, aligned)
   */
  pair(key: string, value: string | number): void {
    if (this.quiet) return;
    this.#stopTask();
    const keyFormatted = chalk.dim(key.padEnd(12));
    console.log(`${keyFormatted}${value}`);
  }

  /**
   * Show plain message with optional color
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
    if (this.quiet) return;
    this.#stopTask();

    if (color) {
      const colorFn = color === "dim" ? chalk.dim : chalk[color];
      console.log(colorFn(message));
    } else {
      console.log(message);
    }
  }

  /**
   * Show success message (green)
   */
  success(message: string): void {
    if (this.quiet) return;
    this.#stopTask();
    console.log(chalk.green(message));
  }

  /**
   * Show info message (dim)
   */
  info(message: string): void {
    if (this.quiet) return;
    this.#stopTask();
    console.log(chalk.dim(message));
  }

  /**
   * Show error message (red) - fails spinner if running
   */
  error(message: string): void {
    if (this.spinner) {
      this.spinner.fail("failed");
      this.spinner = null;
      this.taskStartTime = null;
      this.taskMessage = null;
    }
    console.error(chalk.red(message));
  }

  /**
   * Show warning message (yellow)
   */
  warn(message: string): void {
    if (this.quiet) return;
    this.#stopTask();
    console.warn(chalk.yellow(message));
  }

  /**
   * Exit with code
   */
  exit(code?: number): never {
    this.#stopTask();
    process.exit(code || 0);
  }

  /**
   * Stop spinner without showing result
   */
  #stopTask(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner.clear();
      this.spinner = null;
    }
  }
}
