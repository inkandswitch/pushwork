import * as A from "@automerge/automerge"
import * as diffLib from "diff"

/**
 * Read content from an Automerge document, normalizing legacy ImmutableString
 * values to plain strings for backwards compatibility.
 *
 * Old documents may store text as ImmutableString. This helper ensures callers
 * always get back `string | Uint8Array | null`.
 */
export function readDocContent(content: unknown): string | Uint8Array | null {
	if (content == null) return null
	if (typeof content === "string") return content
	if (content instanceof Uint8Array) return content
	// Legacy ImmutableString — convert to plain string
	if (A.isImmutableString(content)) return content.toString()
	return null
}

/**
 * Update text content on an Automerge document property inside a change
 * callback.
 *
 * If the existing value is already a collaborative text string, we diff and
 * splice for minimal CRDT operations.  If the existing value is a legacy
 * ImmutableString we can't splice into it, so we assign the whole string
 * which converts the field to a collaborative text CRDT going forward.
 *
 * @param doc  - The mutable Automerge document (inside a change callback)
 * @param path - Property path to the text field, e.g. ["content"]
 * @param newContent - The desired new text value
 */
export function updateTextContent(
	doc: any,
	path: A.Prop[],
	newContent: string
): void {
	const target = path.reduce((obj: any, key) => obj?.[key], doc)

	if (typeof target === "string") {
		// Already a collaborative text string — diff and splice
		spliceText(doc, path, target, newContent)
	} else {
		// Legacy ImmutableString, undefined, or other — assign directly.
		// This converts the field to a collaborative text CRDT.
		let obj: any = doc
		for (let i = 0; i < path.length - 1; i++) {
			obj = obj[path[i]]
		}
		obj[path[path.length - 1]] = newContent
	}
}

/**
 * Apply a text diff between oldContent and newContent as Automerge splice
 * operations on the given document property path.
 *
 * This preserves the collaborative text CRDT structure by making minimal
 * character-level edits rather than replacing the entire string.
 *
 * @param doc - The Automerge document (inside a change callback)
 * @param path - The property path to the text field, e.g. ["content"]
 * @param oldContent - The previous text content
 * @param newContent - The desired new text content
 */
export function spliceText(
	doc: any,
	path: A.Prop[],
	oldContent: string,
	newContent: string
): void {
	if (oldContent === newContent) return

	// Fast path: if old is empty, just insert everything
	if (oldContent === "") {
		A.splice(doc, path, 0, 0, newContent)
		return
	}

	// Fast path: if new is empty, just delete everything
	if (newContent === "") {
		A.splice(doc, path, 0, oldContent.length)
		return
	}

	const changes = diffLib.diffChars(oldContent, newContent)

	let pos = 0
	for (const part of changes) {
		if (part.removed) {
			A.splice(doc, path, pos, part.value.length)
			// Don't advance pos — text shifted left after deletion
		} else if (part.added) {
			A.splice(doc, path, pos, 0, part.value)
			pos += part.value.length
		} else {
			// Unchanged text — just advance the cursor
			pos += part.value.length
		}
	}
}
