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
 * Two attributes are understood:
 *
 * - `artifact`: a path with `artifact` set stores its text content as an
 *   atomic, last-writer-wins ImmutableString instead of a live, merge-able
 *   CRDT text. (Link pinning is not an attribute — every link is pinned.)
 * - `datatype=<type>`: a path holding a JSON object is stored as a JSON
 *   document of that Patchwork datatype, whatever its extension, with
 *   `@patchwork.type` set to `<type>`. On the same line, `import=<url>` sets
 *   `@patchwork.suggestedImportUrl`, and `strip-metadata` leaves the
 *   `@patchwork` field out of the file on disk (pushwork rebuilds it from the
 *   rule and the document). `-datatype` unsets an earlier rule.
 *
 *   dist/**     artifact
 *   build/**    artifact
 *   *.wasm      artifact
 *   vendored/   -artifact
 *   *.kanban    datatype=kanban import=automerge:2a5Rkw9LkqXfBAQZbcBWjTcf15Mc strip-metadata
 */
export const ATTRIBUTES_FILE = ".pushworkattributes";

const ARTIFACT = "artifact";
const DATATYPE = "datatype";
const IMPORT = "import";
const STRIP_METADATA = "strip-metadata";

/** The Patchwork datatype a `datatype=` rule assigns to a path. */
export type Datatype = {
	type: string;
	importUrl?: string;
	stripMetadata: boolean;
};

type Rule = { ig: Ignore; set: boolean };

/** `datatype: null` is a `-datatype` rule: it unsets earlier matches. */
type DatatypeRule = { ig: Ignore; datatype: Datatype | null };

export class Attributes {
	private constructor(
		private readonly artifactRules: Rule[],
		private readonly datatypeRules: DatatypeRule[],
	) {}

	/** Parse the text of a `.pushworkattributes` file. */
	static parse(text: string): Attributes {
		const artifactRules: Rule[] = [];
		const datatypeRules: DatatypeRule[] = [];
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const [pattern, ...attrs] = line.split(/\s+/);
			if (!pattern) continue;
			// One matcher per line so we can honor last-match-wins ordering,
			// including negation, exactly like gitattributes.
			const ig = ignore().add(pattern);
			let type: string | null | undefined;
			let importUrl: string | undefined;
			let stripMetadata = false;
			for (const attr of attrs) {
				const unset = attr.startsWith("-");
				const token = unset ? attr.slice(1) : attr;
				const eq = token.indexOf("=");
				const name = eq < 0 ? token : token.slice(0, eq);
				const value = eq < 0 ? undefined : token.slice(eq + 1);
				switch (name) {
					case ARTIFACT:
						artifactRules.push({ ig, set: !unset });
						break;
					case DATATYPE:
						if (unset) type = null;
						else if (value) type = value;
						else dlog("datatype without a value on %s — ignoring", pattern);
						break;
					case IMPORT:
						importUrl = unset ? undefined : value || undefined;
						break;
					case STRIP_METADATA:
						stripMetadata = !unset;
						break;
					default:
						dlog("unknown attribute %s on %s — ignoring", attr, pattern);
				}
			}
			if (type === null) {
				datatypeRules.push({ ig, datatype: null });
			} else if (type !== undefined) {
				datatypeRules.push({ ig, datatype: { type, importUrl, stripMetadata } });
			} else if (importUrl !== undefined || stripMetadata) {
				dlog("%s/%s without datatype on %s — ignoring", IMPORT, STRIP_METADATA, pattern);
			}
		}
		return new Attributes(artifactRules, datatypeRules);
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

	/** Tri-state like {@link artifactOf}: the last matching `datatype` rule's
	 * datatype, `null` when that rule unsets it, undefined when none match. */
	datatypeOf(posixPath: string): Datatype | null | undefined {
		let result: Datatype | null | undefined;
		for (const { ig, datatype } of this.datatypeRules) {
			if (ig.ignores(posixPath)) result = datatype;
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

	/** The Patchwork datatype `posixPath` is assigned, with the same scope and
	 * precedence as {@link isArtifact}. */
	datatypeOf(posixPath: string): Datatype | undefined {
		let result: Datatype | null | undefined;
		for (const { dir, attrs } of this.files) {
			const rel = relativeTo(dir, posixPath);
			if (rel === undefined) continue;
			const match = attrs.datatypeOf(rel);
			if (match !== undefined) result = match;
		}
		return result ?? undefined;
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
