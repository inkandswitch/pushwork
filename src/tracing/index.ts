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
 */
export async function span<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return globalTracer.span(name, fn);
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
