import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const requireHere = createRequire(__filename);

function readVersionFromExports(spec: string): string | undefined {
	try {
		const pkg = requireHere(`${spec}/package.json`) as { version?: string };
		return pkg.version;
	} catch {
		return undefined;
	}
}

function readVersionFromNodeModules(spec: string): string | undefined {
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		const candidate = path.join(dir, "node_modules", spec, "package.json");
		try {
			const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
				version?: string;
			};
			if (pkg.version) return pkg.version;
		} catch {
			// keep walking
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

function readVersion(spec: string): string {
	return (
		readVersionFromExports(spec) ??
		readVersionFromNodeModules(spec) ??
		"(missing)"
	);
}

const ownPkg = requireHere("../package.json") as { version?: string };

export const versions = {
	pushwork: ownPkg.version ?? "(unknown)",
	automerge: readVersion("@automerge/automerge"),
	"automerge-repo": readVersion("@automerge/automerge-repo"),
	"automerge-subduction": readVersion("@automerge/automerge-subduction"),
	"automerge-repo-network-websocket": readVersion(
		"@automerge/automerge-repo-network-websocket",
	),
	"automerge-repo-storage-nodefs": readVersion(
		"@automerge/automerge-repo-storage-nodefs",
	),
	node: process.version.replace(/^v/, ""),
} as const;

export function formatVersions(): string {
	const max = Math.max(...Object.keys(versions).map((k) => k.length));
	const lines = [];
	for (const [k, v] of Object.entries(versions)) {
		lines.push(`${k.padEnd(max)}  ${v}`);
	}
	return lines.join("\n");
}
