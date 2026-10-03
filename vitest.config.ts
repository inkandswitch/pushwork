import { configDefaults, defineConfig } from "vitest/config";

// test/network talks to the real servers; it only runs with `--mode network`.
export default defineConfig(({ mode }) => ({
	test: {
		globals: true,
		environment: "node",
		include:
			mode === "network"
				? ["test/network/**/*.test.ts"]
				: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
		exclude: [...configDefaults.exclude, ...(mode === "network" ? [] : ["test/network/**"])],
		globalSetup: ["./test/global-setup.ts"],
		// Integration tests spawn the CLI and sync over the network.
		testTimeout: 60000,
		hookTimeout: 60000,
	},
}));
