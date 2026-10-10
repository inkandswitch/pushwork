import { createRequire, findPackageJSON } from "node:module";

const require_ = createRequire(__filename);
const versionOf = (pkg: string) =>
	(require_(findPackageJSON(pkg, __filename)!) as { version: string }).version;

export const versions = {
	pushwork: (require_("../package.json") as { version: string }).version,
	automerge: versionOf("@automerge/automerge"),
	"automerge-subduction": versionOf("@automerge/automerge-subduction"),
	node: process.versions.node,
};

export function formatVersions(): string {
	const width = Math.max(...Object.keys(versions).map((k) => k.length));
	return Object.entries(versions)
		.map(([k, v]) => `${k.padEnd(width)}  ${v}`)
		.join("\n");
}
