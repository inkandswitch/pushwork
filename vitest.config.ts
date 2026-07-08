import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
		setupFiles: ["./test/setup.ts"],
		// Build dist/ once up front: integration suites run the compiled CLI.
		globalSetup: ["./test/global-setup.ts"],
		// Many integration tests spawn the CLI as a subprocess; allow time
		// for build server / sync server roundtrips.
		testTimeout: 60000,
		hookTimeout: 60000,
	},
});
