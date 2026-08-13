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
 * An attributes file may sit in any directory, and its rules apply only to
 * paths under that directory (patterns are relative to the file's own
 * location, like `.gitattributes`). Deeper files override shallower ones for
 * the paths they cover, so a subproject can carry its own rules without the
 * root file speaking for it.
 *
 * Format: one `<pattern> <attr>...` rule per line; blank lines and lines
 * starting with `#` are ignored. Patterns are gitignore-style globs. An
 * attribute token is `name` (set) or `-name` (unset). The last rule that
 * matches a given path wins within a file.
 *
 * The only attribute pushwork understands today is `artifact`: a path with
 * `artifact` set stores its text content as an atomic, last-writer-wins
 * ImmutableString instead of a live, merge-able CRDT text. (Link pinning is
 * not an attribute — every link is pinned.)
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
		return this.artifactOf(posixPath) ?? false;
	}

	/** Tri-state match: the last matching rule's verdict, or undefined when
	 * no rule matches — so a deeper file's rules can override this one only
	 * for the paths it actually speaks about. */
	artifactOf(posixPath: string): boolean | undefined {
		let result: boolean | undefined;
		for (const { ig, set } of this.artifactRules) {
			if (ig.ignores(posixPath)) result = set;
		}
		return result;
	}
}

/**
 * Every `.pushworkattributes` file in a working tree, each scoped to its own
 * directory. Files are consulted shallowest first, so on a conflict the
 * deepest file that matches a path wins.
 */
export class AttributesTree {
	constructor(
		private readonly files: { dir: string; attrs: Attributes }[],
	) {}

	get hasArtifactRules(): boolean {
		return this.files.some(({ attrs }) => attrs.hasArtifactRules);
	}

	/** Whether `posixPath` carries the `artifact` attribute, honoring scope
	 * (a file only speaks for paths under its directory) and precedence
	 * (deepest matching file wins, last rule wins within a file). */
	isArtifact(posixPath: string): boolean {
		let result = false;
		for (const { dir, attrs } of this.files) {
			const rel = relativeTo(dir, posixPath);
			if (rel === undefined) continue;
			const match = attrs.artifactOf(rel);
			if (match !== undefined) result = match;
		}
		return result;
	}
}

/**
 * Collect the attributes carried by a walked working tree: every
 * `.pushworkattributes` entry in `files` (as produced by walkDir — so
 * ignored directories never contribute), parsed and scoped to its own
 * directory, ordered shallowest first.
 */
export function attributesTreeOf(
	files: ReadonlyMap<string, Uint8Array>,
): AttributesTree {
	const found: { dir: string; attrs: Attributes }[] = [];
	for (const [posixPath, bytes] of files) {
		const dir = attributesDirOf(posixPath);
		if (dir === undefined) continue;
		const attrs = Attributes.parse(new TextDecoder().decode(bytes));
		dlog("loaded %s (artifact rules: %s)", posixPath, attrs.hasArtifactRules);
		found.push({ dir, attrs });
	}
	found.sort(
		(a, b) => depthOf(a.dir) - depthOf(b.dir) || (a.dir < b.dir ? -1 : 1),
	);
	return new AttributesTree(found);
}

/** The directory an attributes file governs ("" for the root), or undefined
 * when `posixPath` isn't an attributes file at all. */
function attributesDirOf(posixPath: string): string | undefined {
	if (posixPath === ATTRIBUTES_FILE) return "";
	if (posixPath.endsWith("/" + ATTRIBUTES_FILE)) {
		return posixPath.slice(0, -(ATTRIBUTES_FILE.length + 1));
	}
	return undefined;
}

const depthOf = (dir: string) => (dir === "" ? 0 : dir.split("/").length);

/** `posixPath` relative to `dir` when it sits underneath it, else undefined. */
function relativeTo(dir: string, posixPath: string): string | undefined {
	if (dir === "") return posixPath;
	if (posixPath.startsWith(dir + "/")) return posixPath.slice(dir.length + 1);
	return undefined;
}
