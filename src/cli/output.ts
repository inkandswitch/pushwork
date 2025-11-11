import chalk from "chalk";
import ora, { Ora } from "ora";

/**
 * Clean terminal output manager (Singleton)
 * - Progress stays on one line (spinner updates in place)
 * - No emojis
 * - Background colors for section headers
 * - Minimal output
 * - Supports scrolling task lines (max-lines)
 */
export class Output {
  private static instance: Output | null = null;
  private spinner: Ora | null = null;
  private taskStartTime: number | null = null;
  private taskOriginalMessage: string | null = null; // Original task message for done()
  private taskCurrentMessage: string | null = null; // Current display message (can be updated)
  private taskLines: string[] = []; // Lines written during active task
  private taskMaxLines: number = 0; // 0 = unlimited

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): Output {
    if (!Output.instance) {
      Output.instance = new Output();
    }
    return Output.instance;
  }

  /**
   * Reset the singleton (useful for testing)
   */
  static reset(): void {
    if (Output.instance?.spinner) {
      Output.instance.spinner.stop();
      Output.instance.spinner.clear();
    }
    Output.instance = null;
  }

  /**
   * Start a task with spinner - updates in place
   * Completes any previous task before starting the new one
   * @param message - The task message
   * @param maxLines - Maximum number of task lines to show (0 = unlimited, lines scroll)
   */
  task(message: string, maxLines: number = 0): void {
    // Complete any existing task first
    if (this.spinner) {
      this.done();
    }

    this.taskStartTime = Date.now();
    this.taskOriginalMessage = message;
    this.taskCurrentMessage = message;
    this.taskMaxLines = maxLines;
    this.taskLines = [];
    this.spinner = ora(message).start();
  }

  /**
   * Update spinner text (stays on same line)
   */
  update(message: string): void {
    if (this.spinner) {
      this.taskCurrentMessage = message;
      this.#updateTaskDisplay();
    }
  }

  /**
   * Add a line to the active task (appears below spinner, scrolls if max-lines set)
   * Lines are dimmed and temporary - they disappear when task completes unless kept
   * If no task is active, displays as a regular log message
   */
  taskLine(message: string, keepOnComplete: boolean = false): void {
    if (!this.spinner) {
      // No active task, just log normally as regular output
      this.info(message);
      return;
    }

    // Add to task lines buffer with keep flag
    this.taskLines.push(keepOnComplete ? `[keep]${message}` : message);

    // If max lines set, trim from the start (scroll)
    if (this.taskMaxLines > 0 && this.taskLines.length > this.taskMaxLines) {
      this.taskLines = this.taskLines.slice(-this.taskMaxLines);
    }

    this.#updateTaskDisplay();
  }

  /**
   * Clear all task lines (useful when you want to reset the scrolling window)
   */
  clearTaskLines(): void {
    this.taskLines = [];
    this.#updateTaskDisplay();
  }

  /**
   * Update the task display (spinner + task lines)
   * Uses ora's multiline text support to keep spinner at top with lines below
   */
  #updateTaskDisplay(): void {
    if (!this.spinner) return;

    const currentText =
      this.taskCurrentMessage || this.spinner.text.split("\n")[0] || "";

    // If no task lines, show just the spinner message
    if (this.taskLines.length === 0) {
      this.spinner.text = currentText;
      return;
    }

    // Build multiline text: spinner message + task lines below
    const taskLinesText = this.taskLines
      .map((line) => {
        const cleanLine = line.startsWith("[keep]") ? line.slice(6) : line;
        return chalk.dim(`  ${cleanLine}`);
      })
      .join("\n");

    // Set spinner text to include task lines (ora handles multiline rendering)
    this.spinner.text = `${currentText}\n${taskLinesText}`;
  }

  /**
   * Complete task with optional duration display
   * Defaults to showing the original task message with duration
   * Task lines marked with keepOnComplete will be preserved, others are cleared
   */
  done(message?: string, showTime: boolean = true): void {
    if (!this.spinner) return;

    let text = message || this.taskOriginalMessage || "done";
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
      text += chalk.dim(` (${durationText})`);
    }

    // Clear multiline text and set to just completion message
    this.spinner.text = text;
    this.spinner.succeed();
    this.spinner = null;

    // Print kept task lines after completion
    const keptLines = this.taskLines.filter((line) =>
      line.startsWith("[keep]")
    );
    for (const line of keptLines) {
      console.log(chalk.dim(`  ${line.slice(6)}`));
    }

    this.taskStartTime = null;
    this.taskOriginalMessage = null;
    this.taskCurrentMessage = null;
    this.taskLines = [];
    this.taskMaxLines = 0;
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
   * Show success message (green text)
   */
  success(message: string): void {
    this.#stopTask();
    console.log(chalk.green(message));
  }

  /**
   * Show success block (green background label + optional message)
   */
  successBlock(label: string, message: string = ""): void {
    this.#stopTask();
    console.log(
      `\n${chalk.bgGreen.black(` ${label} `)}${message && ` ${message}`}`
    );
  }

  /**
   * Show success message (green text)
   */
  spicy(message: string): void {
    this.#stopTask();
    console.log(chalk.cyan(message));
  }

  /**
   * Show success block (green background label + optional message)
   */
  spicyBlock(label: string, message: string = ""): void {
    this.#stopTask();
    console.log(
      `\n${chalk.bgCyan.black(` ${label} `)}${message && ` ${message}`}`
    );
  }

  /**
   * Show message with rainbow gradient
   */
  rainbow(message: string): void {
    this.#stopTask();

    // Rainbow colors in order
    const colors = [
      chalk.red,
      chalk.rgb(255, 165, 0), // orange
      chalk.yellow,
      chalk.green,
      chalk.cyan,
      chalk.blue,
      chalk.magenta,
    ];

    const chars = message.split("");
    const colorCount = colors.length;

    // Spread colors across the string
    const rainbow = chars
      .map((char, i) => {
        // Calculate which color to use based on position
        const colorIndex = Math.floor((i / chars.length) * colorCount);
        const color = colors[Math.min(colorIndex, colorCount - 1)];
        return color(char);
      })
      .join("");

    console.log(rainbow);
  }

  /**
   * Show info message (dim text)
   */
  info(message: string): void {
    this.#stopTask();
    console.log(chalk.dim(message));
  }

  /**
   * Show info block (grey background label + optional message)
   */
  infoBlock(label: string, message: string = ""): void {
    this.#stopTask();
    console.log(
      `\n${chalk.bgGrey.white(` ${label} `)}${message && ` ${message}`}`
    );
  }

  /**
   * Show error message (red text) - fails spinner if running
   */
  error(message: string | Error | unknown): void {
    if (this.spinner) {
      this.spinner.fail("failed");
      this.spinner = null;
      this.taskStartTime = null;
      this.taskOriginalMessage = null;
      this.taskCurrentMessage = null;
    }
    console.log(
      chalk.red(
        message instanceof Error
          ? message.message
          : message instanceof Object
          ? JSON.stringify(message)
          : String(message)
      )
    );
  }

  /**
   * Show error block (red background label + optional message) - fails spinner if running
   */
  errorBlock(label: string, message: string = ""): void {
    if (this.spinner) {
      this.spinner.fail("failed");
      this.spinner = null;
      this.taskStartTime = null;
      this.taskOriginalMessage = null;
      this.taskCurrentMessage = null;
    }
    console.log(
      `\n${chalk.bgRed.white(` ${label} `)}${message && ` ${message}`}`
    );
  }

  /**
   * Show warning message (yellow text)
   */
  warn(message: string): void {
    this.#stopTask();
    console.log(chalk.yellow(message));
  }

  /**
   * Show warning block (yellow background label + optional message)
   */
  warnBlock(label: string, message: string = ""): void {
    this.#stopTask();
    console.log(
      `\n${chalk.bgYellow.black(` ${label} `)}${message && ` ${message}`}`
    );
  }

  /**
   * Show detailed error information and exit the program
   * Use this when an unexpected/unrecoverable error occurs
   * Shows error message and stack trace, then exits
   */
  crash(error: unknown, exitCode: number = 1): never {
    this.#stopTask();

    if (error instanceof Error) {
      // Error type and message
      console.log(chalk.red(`${error.name}: ${error.message}`));

      // Stack trace
      if (error.stack) {
        console.log("");
        console.log(chalk.dim("Stack trace:"));
        const stackLines = error.stack.split("\n").slice(1); // Skip first line (error message)
        stackLines.forEach((line) =>
          console.log(chalk.dim(`  ${line.trim()}`))
        );
      }
    } else {
      console.log(chalk.red(String(error)));
    }

    process.exit(exitCode);
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
    this.taskStartTime = null;
    this.taskOriginalMessage = null;
    this.taskCurrentMessage = null;
    this.taskLines = [];
    this.taskMaxLines = 0;
  }
}

/**
 * Global singleton output instance
 * Import and use this anywhere in your code
 */
export const out = Output.getInstance();
