/**
 * Vitest setup: stub ESM-only modules that misbehave under bundled tests.
 */
import { vi } from "vitest";

// chalk is ESM-only and misbehaves under bundled unit tests; stub it to
// identity functions. (The CLI runs in a real subprocess in integration
// tests, so it still gets the real chalk there.)
vi.mock("chalk", () => ({
	default: new Proxy(
		{},
		{
			get: (target, prop) => {
				if (prop === "default") return target;
				return (str: string) => str;
			},
		},
	),
}));
