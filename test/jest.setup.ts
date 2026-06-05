/**
 * Jest setup file to mock ESM modules that don't work well with Jest
 */

// uuid@14 is ESM-only; automerge-repo imports it from CJS tests
jest.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));

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

// Mock ora (ESM-only module)
jest.mock("ora", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    warn: jest.fn().mockReturnThis(),
    info: jest.fn().mockReturnThis(),
    clear: jest.fn().mockReturnThis(),
    text: "",
  })),
}));

