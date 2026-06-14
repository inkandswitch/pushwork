/**
 * Jest setup file to mock ESM modules that don't work well with Jest
 */

// Mock chalk (ESM-only module)
jest.mock("chalk", () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === "default") return target;
        // Return a function that returns the input string unchanged
        return (str: string) => str;
      },
    }
  ),
}));

// Mock @clack/prompts (ESM-only): unit tests must not draw spinners or
// frames on the test runner's terminal, and prompts must never block.
// Interactive-mode rendering isn't asserted in unit tests — the porcelain
// and quiet/silent paths in output.ts bypass clack entirely and are
// covered by test/unit/output.test.ts.
jest.mock("@clack/prompts", () => ({
  __esModule: true,
  intro: jest.fn(),
  outro: jest.fn(),
  cancel: jest.fn(),
  isCancel: jest.fn(() => false),
  confirm: jest.fn(async () => false),
  spinner: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    cancel: jest.fn(),
    error: jest.fn(),
    message: jest.fn(),
    clear: jest.fn(),
    isCancelled: false,
  })),
  progress: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    cancel: jest.fn(),
    error: jest.fn(),
    message: jest.fn(),
    clear: jest.fn(),
    advance: jest.fn(),
    isCancelled: false,
  })),
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    message: jest.fn(),
    step: jest.fn(),
  },
}));

