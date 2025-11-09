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

  constructor(quiet = false) {
    this.quiet = quiet;
  }

  /**
   * Start a task with spinner - updates in place
   */
  task(message: string): void {
    if (this.quiet) return;
    this.stopSpinner();
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
   * Complete task with optional duration
   */
  done(message?: string, startTime?: number): void {
    if (this.quiet) return;

    let text = message || "done";
    if (startTime) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      text += ` (${duration}s)`;
    }

    if (this.spinner) {
      this.spinner.succeed(text);
      this.spinner = null;
    }
  }

  /**
   * Fail task with error
   */
  fail(message?: string): void {
    if (this.quiet) return;
    if (this.spinner) {
      this.spinner.fail(message || "failed");
      this.spinner = null;
    }
  }

  /**
   * Show a section header with background color
   */
  section(
    type: "success" | "error" | "warning" | "info" | "status" | "partial",
    message: string
  ): void {
    if (this.quiet) return;
    this.stopSpinner();

    const label = type.toUpperCase().padEnd(8);
    let styled: string;

    switch (type) {
      case "success":
        styled = chalk.bgGreen.black(` ${label} `);
        break;
      case "error":
        styled = chalk.bgRed.white(` ${label} `);
        break;
      case "warning":
        styled = chalk.bgYellow.black(` ${label} `);
        break;
      case "partial":
        styled = chalk.bgYellow.black(` ${label} `);
        break;
      case "status":
        styled = chalk.bgBlue.white(` ${label} `);
        break;
      default:
        styled = chalk.bgWhite.black(` ${label} `);
    }

    console.log(`\n${styled} ${message}`);
  }

  /**
   * Show a key-value pair (indented)
   */
  detail(key: string, value: string | number): void {
    if (this.quiet) return;
    this.stopSpinner();
    const keyFormatted = chalk.dim(key.padEnd(12));
    console.log(`  ${keyFormatted}${value}`);
  }

  /**
   * Show a list item (indented)
   */
  item(message: string): void {
    if (this.quiet) return;
    this.stopSpinner();
    console.log(`  ${chalk.dim("•")} ${message}`);
  }

  /**
   * Show plain message
   */
  log(message: string): void {
    if (this.quiet) return;
    this.stopSpinner();
    console.log(message);
  }

  /**
   * Show error message (in red)
   */
  error(message: string): void {
    this.stopSpinner();
    console.error(chalk.red(message));
  }

  /**
   * Show warning message (in yellow)
   */
  warn(message: string): void {
    if (this.quiet) return;
    this.stopSpinner();
    console.warn(chalk.yellow(message));
  }

  /**
   * Exit with code
   */
  exit(code: number): never {
    this.stopSpinner();
    process.exit(code);
  }

  /**
   * Stop spinner without showing result
   */
  private stopSpinner(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner.clear();
      this.spinner = null;
    }
  }
}
