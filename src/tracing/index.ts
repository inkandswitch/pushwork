import { Tracer } from "./tracer";

const globalTracer = new Tracer();

/**
 * Start/stop tracing for this CLI invocation
 */
export function trace(enable: boolean): Tracer {
  globalTracer.setEnabled(enable);
  return globalTracer;
}

/**
 * Get the current tracer (always available)
 */
export function getTracer(): Tracer {
  return globalTracer;
}

/**
 * Trace an async operation
 * Pass the Promise directly for type safety
 *
 * Usage:
 *   await span("operation", someAsyncCall())
 *   await span("operation", someAsyncCall(), { key: "value" })
 */
export async function span<T>(
  name: string,
  promise: Promise<T>,
  attributes?: Record<string, any>
): Promise<T> {
  return globalTracer.span(name, promise, attributes);
}

/**
 * Trace a sync operation
 */
export function spanSync<T>(name: string, fn: () => T): T {
  return globalTracer.spanSync(name, fn);
}

/**
 * Set an attribute on the current span
 */
export function attr(key: string, value: any): void {
  globalTracer.attr(key, value);
}

export { Tracer } from "./tracer";
