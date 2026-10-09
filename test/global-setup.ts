import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { createRequire } from "module";
import * as path from "path";
import type { GlobalSetupContext } from "vitest/node";
import { setHome } from "./home";
import { startServer } from "./server";

declare module "vitest" {
	export interface ProvidedContext {
		server: string;
	}
}

// Integration suites run the compiled CLI, so build dist/ once up front.
export default async function setup({ provide }: GlobalSetupContext) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-test-home-"));
	setHome(home);
	const root = path.join(__dirname, "..");
	const tsc = createRequire(__filename).resolve("typescript/lib/tsc.js");
	execFileSync(process.execPath, [tsc, "-p", path.join(root, "tsconfig.json")], {
		stdio: "inherit",
	});
	const server = await startServer();
	provide("server", server.url);
	return async () => {
		await server.close();
		fs.rmSync(home, { recursive: true, force: true });
	};
}
