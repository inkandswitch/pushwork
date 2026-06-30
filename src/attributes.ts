import * as fs from "fs/promises";
import * as path from "path";
import ignore, { type Ignore } from "ignore";
import { log } from "./log.js";

const dlog = log("attributes");

/**
 * `.pushworkattributes` assigns attributes to paths, modeled on
 * `.gitattributes` (and a sibling to `.pushworkignore`). It is an ordinary
 * tracked file, so it travels *with the repo content* — every clone of a repo
 * sees the same attributes. That makes it the home for path-scoped
 * configuration all collaborators must agree on, in contrast to
 * `.pushwork/config.json`, which is local, per-checkout machine state.
 *
 * Format: one `<pattern> <attr>...` rule per line; blank lines and lines
 * starting with `#` are ignored. Patterns are gitignore-style globs. An
 * attribute token is `name` (set) or `-name` (unset). The last rule that
 * matches a given path wins.
 *
 * The only attribute pushwork understands today is `artifact`: a path with
 * `artifact` set is stored as an immutable, heads-pinned, opaque blob in the
 * root doc rather than a live, merge-able CRDT document.
 *
 *   dist/**     artifact
 *   build/**    artifact
 *   *.wasm      artifact
 *   vendored/   -artifact
 */
export const ATTRIBUTES_FILE = ".pushworkattributes";

const ARTIFACT = "artifact";

type Rule = { ig: Ignore; set: boolean };

export class Attributes {
	private constructor(private readonly artifactRules: Rule[]) {}

	/** Parse the text of a `.pushworkattributes` file. */
	static parse(text: string): Attributes {
		const artifactRules: Rule[] = [];
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const [pattern, ...attrs] = line.split(/\s+/);
			if (!pattern) continue;
			for (const attr of attrs) {
				const unset = attr.startsWith("-");
				const name = (unset ? attr.slice(1) : attr).split("=")[0];
				if (name !== ARTIFACT) {
					dlog("unknown attribute %s on %s — ignoring", attr, pattern);
					continue;
				}
				// One matcher per rule so we can honor last-match-wins ordering,
				// including negation, exactly like gitattributes.
				artifactRules.push({ ig: ignore().add(pattern), set: !unset });
			}
		}
		return new Attributes(artifactRules);
	}

	/** Whether any `artifact` rule was declared (empty/no file → false). */
	get hasArtifactRules(): boolean {
		return this.artifactRules.length > 0;
	}

	/** Whether `posixPath` carries the `artifact` attribute (last rule wins). */
	isArtifact(posixPath: string): boolean {
		let result = false;
		for (const { ig, set } of this.artifactRules) {
			if (ig.ignores(posixPath)) result = set;
		}
		return result;
	}
}

/** Read `.pushworkattributes` from the repo root, or null if absent. */
export async function readAttributes(root: string): Promise<Attributes | null> {
	let text: string;
	try {
		text = await fs.readFile(path.join(root, ATTRIBUTES_FILE), "utf8");
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") return null;
		throw err;
	}
	const attrs = Attributes.parse(text);
	dlog("loaded %s (artifact rules: %s)", ATTRIBUTES_FILE, attrs.hasArtifactRules);
	return attrs;
}
