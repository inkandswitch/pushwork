/**
 * Vitest setup: stub ESM-only modules that misbehave under bundled tests.
 */
import { vi } from "vitest";

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

vi.mock("ora", () => ({
	default: vi.fn(() => ({
		start: vi.fn().mockReturnThis(),
		stop: vi.fn().mockReturnThis(),
		succeed: vi.fn().mockReturnThis(),
		fail: vi.fn().mockReturnThis(),
		warn: vi.fn().mockReturnThis(),
		info: vi.fn().mockReturnThis(),
		clear: vi.fn().mockReturnThis(),
		text: "",
	})),
}));
