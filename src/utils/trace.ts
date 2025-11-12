import { out } from "../cli/output";

/**
 * Global tracing state
 */
let tracingEnabled = false;

/**
 * Enable or disable tracing
 */
export function setTracingEnabled(enabled: boolean): void {
  tracingEnabled = enabled;
}

/**
 * Check if tracing is enabled
 */
export function isTracingEnabled(): boolean {
  return tracingEnabled;
}

/**
 * Trace a span of work by outputting to console
 * Works for both sync and async functions
 * Only outputs if tracing is enabled
 *
 * Usage:
 *   await span("operation", async () => { ... })
 *   span("operation", () => { ... })
 */
export function span<T>(
  name: string,
  fn: () => T | Promise<T>
): T | Promise<T> {
  if (!tracingEnabled) {
    return fn();
  }

  const start = performance.now();
  const result = fn();

  // Check if it's a promise (async)
  if (result instanceof Promise) {
    return result.then((value) => {
      const duration = performance.now() - start;
      out.taskLine(`${name} (${formatDuration(duration)})`, true);
      return value;
    }) as T;
  }

  // Sync case
  const duration = performance.now() - start;
  out.taskLine(`${name} (${formatDuration(duration)})`, true);
  return result;
}

/**
 * Format duration for display
 */
function formatDuration(ms: number): string {
  if (ms < 1) {
    return `${ms.toFixed(2)}ms`;
  } else if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  } else if (ms < 2000) {
    return `${(ms / 1000).toFixed(2)}s`;
  } else {
    return `${(ms / 1000).toFixed(1)}s`;
  }
}
