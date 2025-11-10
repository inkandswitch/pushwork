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
  private taskStartTime: number | null = null;
  private taskMessage: string | null = null;

  /**
   * Start a task with spinner - updates in place
   */
  task(message: string): void {
    this.#stopTask();
    this.taskStartTime = Date.now();
    this.taskMessage = message;
    this.spinner = ora(message).start();
  }

  /**
   * Update spinner text (stays on same line)
   */
  update(message: string): void {
    if (this.spinner) {
      this.spinner.text = message;
    }
  }

  /**
   * Complete task with optional duration display
   * Defaults to showing the original task message with duration
   */
  done(message?: string, showTime: boolean = true): void {
    let text = message || this.taskMessage || "done";
    if (showTime && this.taskStartTime) {
      const durationMs = Date.now() - this.taskStartTime;
      const durationText = (() => {
        switch (true) {
          case durationMs < 1000:
            return `${durationMs}ms`;
          case durationMs < 2000:
            return `${(durationMs / 1000).toFixed(2)}s`;
          default:
            return `${(durationMs / 1000).toFixed(1)}s`;
        }
      })();
      text += ` (${durationText})`;
    }

    if (this.spinner) {
      this.spinner.succeed(text);
      this.spinner = null;
    }
    this.taskStartTime = null;
    this.taskMessage = null;
  }

  /**
   * Show a key-value pair (indented, aligned)
   */
  pair(key: string, value: string | number): void {
    this.#stopTask();
    const keyFormatted = chalk.dim(key.padEnd(12));
    console.log(`${keyFormatted}${value}`);
  }

  /**
   * Show an object as a table of key-value pairs
   * Filters out undefined values and applies optional transforms
   * Automatically calculates key padding from max key length
   */
  obj(
    obj: Record<string, any>,
    keyTransform?: (key: string) => string,
    valueTransform?: (value: any, key: string) => string
  ): void {
    this.#stopTask();

    // Filter out undefined values and apply key transform
    const entries: Array<[string, string, any]> = [];
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue;
      const displayKey = keyTransform ? keyTransform(key) : key;
      entries.push([key, displayKey, value]);
    }

    // Calculate max key length for padding
    const maxKeyLength = Math.max(
      ...entries.map(([, displayKey]) => displayKey.length)
    );

    // Print each entry
    for (const [key, displayKey, value] of entries) {
      const displayValue = valueTransform
        ? valueTransform(value, key)
        : String(value);
      const keyFormatted = chalk.dim(displayKey.padEnd(maxKeyLength + 2));
      console.log(`${keyFormatted}${displayValue}`);
    }
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
   * - 1 arg: green text
   * - 2 args: green background label + message
   */
  success(labelOrMessage: string, message?: string): void {
    this.#stopTask();
    console.log(
      this.#fmt(
        labelOrMessage,
        message,
        (text) => chalk.bgGreen.black(text),
        (text) => chalk.green(text)
      )
    );
  }

  /**
   * Show info message (dim/grey)
   * - 1 arg: dim text
   * - 2 args: grey background label + message
   */
  info(labelOrMessage: string, message?: string): void {
    this.#stopTask();
    console.log(
      this.#fmt(
        labelOrMessage,
        message,
        (text) => chalk.bgGrey.white(text),
        (text) => chalk.dim(text)
      )
    );
  }

  /**
   * Show info message (dim/grey)
   * - 1 arg: dim text
   * - 2 args: grey background label + message
   */
  special(labelOrMessage: string, message?: string): void {
    this.#stopTask();
    console.log(
      this.#fmt(
        labelOrMessage,
        message,
        (text) => chalk.bgCyan.black(text),
        (text) => chalk.cyan(text)
      )
    );
  }

  /**
   * Show error message (red) - fails spinner if running
   * - 1 arg: red text
   * - 2 args: red background label + message
   */
  error(labelOrMessage: string, message?: string): void {
    if (this.spinner) {
      this.spinner.fail("failed");
      this.spinner = null;
      this.taskStartTime = null;
      this.taskMessage = null;
    }
    console.log(
      this.#fmt(
        labelOrMessage,
        message,
        (text) => chalk.bgRed.white(text),
        (text) => chalk.red(text)
      )
    );
  }

  /**
   * Show warning message (yellow)
   * - 1 arg: yellow text
   * - 2 args: yellow background label + message
   */
  warn(labelOrMessage: string, message?: string): void {
    this.#stopTask();
    console.log(
      this.#fmt(
        labelOrMessage,
        message,
        (text) => chalk.bgYellow.black(text),
        (text) => chalk.yellow(text)
      )
    );
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

  #fmt(
    labelOrMessage: string,
    message: string | undefined,
    bgColorFn: (text: string) => string,
    fgColorFn: (text: string) => string
  ): string {
    if (message !== undefined) {
      const styled = bgColorFn(` ${labelOrMessage} `);
      return `\n${styled} ${message}`;
    }
    return fgColorFn(labelOrMessage);
  }
}
