import {
  trace,
  SpanStatusCode,
  Tracer as OtelTracer,
} from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  InMemorySpanExporter,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/**
 * OpenTelemetry-based tracer for performance instrumentation
 */
export class Tracer {
  private provider: NodeTracerProvider;
  private exporter: InMemorySpanExporter;
  private tracer: OtelTracer;
  private enabled: boolean = false;

  constructor() {
    this.exporter = new InMemorySpanExporter();
    const processor = new BatchSpanProcessor(this.exporter);
    this.provider = new NodeTracerProvider({
      spanProcessors: [processor],
    });
    this.provider.register();
    this.tracer = trace.getTracer("pushwork");
  }

  /**
   * Enable/disable tracing
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.reset();
    }
  }

  /**
   * Check if tracing is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Set an attribute on the current active span
   */
  attr(key: string, value: any): void {
    if (!this.enabled) return;
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttribute(key, value);
    }
  }

  /**
   * Add a mark/instant event to the trace
   * Creates a zero-duration span using OpenTelemetry's API
   *
   * Usage:
   *   mark("🎯 Starting expensive operation")
   *   mark("checkpoint", { step: 3, status: "processing" })
   */
  mark(name: string, attributes?: Record<string, any>): void {
    if (!this.enabled) return;

    // Create a proper zero-duration span using OpenTelemetry
    const span = this.tracer.startSpan(name);
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }
    }
    // Immediately end it - this creates a zero-duration span
    span.end();
  }

  /**
   * Trace a synchronous operation
   * Uses OpenTelemetry's standard span API with proper context propagation
   */
  spanSync<T>(name: string, fn: () => T): T {
    if (!this.enabled) return fn();

    return this.tracer.startActiveSpan(name, (span) => {
      try {
        const result = fn();
        span.end();
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
      }
    });
  }

  /**
   * Trace an async operation
   * Pass the Promise directly - this prevents accidentally passing sync functions
   * that return Promises, which would end the span too early.
   *
   * Usage:
   *   await span("operation", someAsyncCall())
   *   await span("operation", someAsyncCall(), { key: "value" })
   */
  async span<T>(
    name: string,
    promise: Promise<T>,
    attributes?: Record<string, any>
  ): Promise<T> {
    if (!this.enabled) return promise;

    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        if (attributes) {
          for (const [key, value] of Object.entries(attributes)) {
            span.setAttribute(key, value);
          }
        }
        const result = await promise;
        span.end();
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
      }
    });
  }

  /**
   * Export to Chrome DevTools trace format
   * This is the standard format for file-based trace visualization
   * Supported by chrome://tracing and ui.perfetto.dev
   */
  toChromeTrace(): any {
    // Force flush to ensure all spans are exported
    this.provider.forceFlush();

    const spans = this.exporter.getFinishedSpans();
    const events: any[] = [];

    for (const span of spans) {
      // OpenTelemetry stores time as [seconds, nanoseconds]
      // Chrome trace format uses microseconds
      const startTime =
        span.startTime[0] * 1_000_000 + Math.floor(span.startTime[1] / 1000);
      const endTime =
        span.endTime[0] * 1_000_000 + Math.floor(span.endTime[1] / 1000);

      // Use Complete events (X) - they show up properly under "Process 1"
      // Perfetto should handle overlapping via proper parent-child nesting from OpenTelemetry
      events.push({
        name: span.name,
        cat: "function",
        ph: "X",
        ts: startTime,
        dur: endTime - startTime,
        pid: 1,
        tid: 1,
        args: span.attributes || {},
      });
    }

    return {
      traceEvents: events,
      displayTimeUnit: "ms",
    };
  }

  /**
   * Reset tracer state
   * Clears all collected spans for the next tracing session
   */
  reset(): void {
    this.exporter.reset();
  }
}
