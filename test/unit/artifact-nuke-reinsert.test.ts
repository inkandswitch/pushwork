/**
 * Test that the artifact directory "nuke and rebuild" logic doesn't
 * blow up when unchanged entries are pushed back into the docs array.
 *
 * Automerge throws "Cannot create a reference to an existing document object"
 * if you splice out an entry from an array and then push the same proxy object
 * back in. The fix is to always spread entries into plain objects.
 */

import * as A from "@automerge/automerge"

interface DirectoryEntry {
	name: string
	type: "file" | "folder"
	url: string
}

interface DirectoryDocument {
	name: string
	title: string
	docs: DirectoryEntry[]
	[key: string]: unknown
}

describe("Artifact directory nuke and rebuild", () => {
	it("should not throw when unchanged entries are spliced out and pushed back", () => {
		// Create a directory document with some entries
		let doc = A.from<DirectoryDocument>({
			name: "dist",
			title: "dist",
			docs: [
				{ name: "index.js", type: "file", url: "automerge:abc123" },
				{ name: "utils.js", type: "file", url: "automerge:def456" },
				{ name: "styles.css", type: "file", url: "automerge:ghi789" },
			],
		})

		// Simulate the nuke-and-rebuild: update one entry, keep the others unchanged.
		// This is the pattern from batchUpdateDirectory's artifact path.
		const updatedMap = new Map([["index.js", "automerge:newurl123"]])
		const deletedSet = new Set<string>()
		const newMap = new Map<string, string>()
		const subdirMap = new Map<string, string>()

		// BUG REPRODUCTION: pushing back unchanged Automerge proxy objects
		// after splicing them out throws "Cannot create a reference to an
		// existing document object"
		expect(() => {
			doc = A.change(doc, (d) => {
				const kept: DirectoryEntry[] = []
				for (const entry of d.docs) {
					if (entry.type === "file" && deletedSet.has(entry.name)) continue
					if (entry.type === "file" && updatedMap.has(entry.name)) {
						kept.push({ ...entry, url: updatedMap.get(entry.name)! })
						continue
					}
					if (entry.type === "file" && newMap.has(entry.name)) {
						kept.push({ ...entry, url: newMap.get(entry.name)! })
						newMap.delete(entry.name)
						continue
					}
					if (entry.type === "folder" && subdirMap.has(entry.name)) {
						kept.push({ ...entry, url: subdirMap.get(entry.name)! })
						continue
					}
					// This is the critical line: spreading creates a plain object copy
					// instead of keeping the Automerge proxy reference
					kept.push({ ...entry })
				}

				for (const [name, url] of newMap) {
					kept.push({ name, type: "file", url })
				}

				// Nuke and rebuild
				d.docs.splice(0, d.docs.length)
				for (const entry of kept) {
					d.docs.push(entry)
				}
			})
		}).not.toThrow()

		// Verify the result
		expect(doc.docs).toHaveLength(3)
		expect(doc.docs[0].name).toBe("index.js")
		expect(doc.docs[0].url).toBe("automerge:newurl123")
		expect(doc.docs[1].name).toBe("utils.js")
		expect(doc.docs[1].url).toBe("automerge:def456")
		expect(doc.docs[2].name).toBe("styles.css")
		expect(doc.docs[2].url).toBe("automerge:ghi789")
	})

	it("throws when unchanged proxy objects are pushed back without spreading", () => {
		let doc = A.from<DirectoryDocument>({
			name: "dist",
			title: "dist",
			docs: [
				{ name: "index.js", type: "file", url: "automerge:abc123" },
				{ name: "utils.js", type: "file", url: "automerge:def456" },
			],
		})

		const updatedMap = new Map([["index.js", "automerge:newurl123"]])

		// This demonstrates the bug: pushing back the raw proxy object
		expect(() => {
			doc = A.change(doc, (d) => {
				const kept: DirectoryEntry[] = []
				for (const entry of d.docs) {
					if (updatedMap.has(entry.name)) {
						kept.push({ ...entry, url: updatedMap.get(entry.name)! })
						continue
					}
					// BUG: pushing the proxy object directly
					kept.push(entry)
				}

				d.docs.splice(0, d.docs.length)
				for (const entry of kept) {
					d.docs.push(entry) // throws here for the unchanged proxy
				}
			})
		}).toThrow("Cannot create a reference to an existing document object")
	})
})
