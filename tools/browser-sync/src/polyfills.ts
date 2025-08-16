/**
 * Browser polyfills for Node.js globals
 */

// Define process global
(globalThis as any).process = {
  env: {},
  version: "v18.0.0",
  platform: "browser",
  nextTick: (fn: Function) => setTimeout(fn, 0),
  cwd: () => "/",
  argv: [],
  exit: () => {},
  stderr: { write: console.error },
  stdout: { write: console.log },
};

// Define Buffer global (minimal implementation)
(globalThis as any).Buffer = {
  from: (data: any) => new Uint8Array(data),
  alloc: (size: number) => new Uint8Array(size),
  isBuffer: () => false,
};

// Define global if not present
if (typeof (globalThis as any).global === "undefined") {
  (globalThis as any).global = globalThis;
}

// Export for TypeScript
export {};
