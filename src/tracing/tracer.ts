import { AsyncLocalStorage } from "async_hooks";

/**
 * Span represents a single timed operation
 */
interface Span {
  name: string;
  startTime: number;
  endTime?: number;
  parent: Span | null;
  children: Span[];
  attributes: Record<string, any>;
}

/**
 * Accumulated timing data for operations that may be called multiple times
 */
interface TimingEntry {
  total: number; // Total time in ms
  count: number; // Number of times called
  min?: number; // Minimum duration
  max?: number; // Maximum duration
}

/**
 * Context stored in AsyncLocalStorage for each async call chain
 */
interface SpanContext {
  currentSpan: Span | null;
}

/**
 * Hierarchical tracer using AsyncLocalStorage for concurrency support
 */
export class Tracer {
  private rootSpan: Span | null = null;
  private timings: Map<string, TimingEntry> = new Map();
  private contextStorage = new AsyncLocalStorage<SpanContext>();
  private enabled: boolean = false;

  /**
   * Enable/disable tracing
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled && !this.rootSpan) {
      // Initialize on first enable
    }
  }

  /**
   * Check if tracing is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get current span from AsyncLocalStorage context
   */
  private getCurrentSpan(): Span | null {
    if (!this.enabled) return null;
    const context = this.contextStorage.getStore();
    return context?.currentSpan || null;
  }

  /**
   * Set current span in AsyncLocalStorage context
   */
  private setCurrentSpan(span: Span | null): void {
    if (!this.enabled) return;
    const context = this.contextStorage.getStore();
    if (context) {
      context.currentSpan = span;
    }
  }

  /**
   * Start a new span
   * Uses AsyncLocalStorage for proper concurrency handling
   */
  private startSpan(name: string): Span {
    if (!this.enabled) {
      // Return a dummy span when disabled
      return {
        name,
        startTime: -1,
        parent: null,
        children: [],
        attributes: {},
      };
    }

    const parent = this.getCurrentSpan();

    const span: Span = {
      name,
      startTime: Date.now(),
      parent,
      children: [],
      attributes: {},
    };

    if (!this.rootSpan) {
      this.rootSpan = span;
    }

    if (parent) {
      parent.children.push(span);
    }

    this.setCurrentSpan(span);
    return span;
  }

  /**
   * End a specific span
   */
  private endSpan(span: Span): void {
    if (!this.enabled) return;

    span.endTime = Date.now();
    const duration = span.endTime - span.startTime;

    // Accumulate timing data
    const existing = this.timings.get(span.name) || {
      total: 0,
      count: 0,
    };

    this.timings.set(span.name, {
      total: existing.total + duration,
      count: existing.count + 1,
      min:
        existing.min !== undefined
          ? Math.min(existing.min, duration)
          : duration,
      max:
        existing.max !== undefined
          ? Math.max(existing.max, duration)
          : duration,
    });

    // Restore parent in AsyncLocalStorage context
    this.setCurrentSpan(span.parent);
  }

  /**
   * Set an attribute on the current span
   */
  attr(key: string, value: any): void {
    if (!this.enabled) return;
    const span = this.getCurrentSpan();
    if (span) {
      span.attributes[key] = value;
    }
  }

  /**
   * Trace a synchronous operation
   */
  spanSync<T>(name: string, fn: () => T): T {
    if (!this.enabled) return fn();

    return this.contextStorage.run(
      { currentSpan: this.getCurrentSpan() },
      () => {
        const span = this.startSpan(name);
        try {
          return fn();
        } finally {
          this.endSpan(span);
        }
      }
    );
  }

  /**
   * Trace an async operation
   */
  async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();

    return this.contextStorage.run(
      { currentSpan: this.getCurrentSpan() },
      async () => {
        const span = this.startSpan(name);
        try {
          return await fn();
        } finally {
          this.endSpan(span);
        }
      }
    );
  }

  /**
   * Get accumulated timings (compatible with current format)
   */
  getTimings(): Record<string, number> {
    const result: Record<string, number> = {};

    for (const [name, entry] of this.timings.entries()) {
      result[name] = entry.total;

      // Add count if called multiple times
      if (entry.count > 1) {
        result[`${name}.count`] = entry.count;
        result[`${name}.avg`] = entry.total / entry.count;
        if (entry.min !== undefined) result[`${name}.min`] = entry.min;
        if (entry.max !== undefined) result[`${name}.max`] = entry.max;
      }
    }

    return result;
  }

  /**
   * Export to Chrome DevTools trace format for flame graphs
   * Open the JSON in chrome://tracing
   *
   * Robustly handles unclosed spans by auto-closing them
   */
  toChromeTrace(): any {
    if (!this.rootSpan) return { traceEvents: [] };

    const events: any[] = [];
    const processId = 1;
    const threadId = 1;
    const now = Date.now();

    const addSpan = (span: Span) => {
      // Auto-close unclosed spans with current time
      const endTime = span.endTime || now;

      // Begin event
      events.push({
        name: span.name,
        cat: "function",
        ph: "B", // Begin
        ts: span.startTime * 1000, // microseconds
        pid: processId,
        tid: threadId,
        args: span.attributes,
      });

      // Process children FIRST (so they're nested inside)
      span.children.forEach(addSpan);

      // End event
      events.push({
        name: span.name,
        cat: "function",
        ph: "E", // End
        ts: endTime * 1000, // microseconds
        pid: processId,
        tid: threadId,
      });
    };

    addSpan(this.rootSpan);

    return {
      traceEvents: events,
      displayTimeUnit: "ms",
    };
  }

  /**
   * Reset tracer state
   */
  reset(): void {
    this.rootSpan = null;
    this.timings.clear();
  }
}
