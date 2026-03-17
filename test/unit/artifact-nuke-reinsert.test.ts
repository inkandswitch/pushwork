/**
 * Test that nukeAndRebuildDocs (the actual production function used by
 * batchUpdateDirectory for artifact directories) doesn't throw
 * "Cannot create a reference to an existing document object" when
 * unchanged entries are spliced out and pushed back.
 */

import * as A from "@automerge/automerge"
import { AutomergeUrl } from "@automerge/automerge-repo"
import { nukeAndRebuildDocs } from "../../src/core/sync-engine"
import { DirectoryDocument } from "../../src/types/documents"

describe("nukeAndRebuildDocs", () => {
	let doc: A.Doc<DirectoryDocument>

	beforeEach(() => {
		doc = A.from({
			"@patchwork": {type: "folder"},
			name: "dist",
			title: "dist",
			docs: [
				{name: "index.js", type: "file", url: "automerge:abc123"},
				{name: "utils.js", type: "file", url: "automerge:def456"},
				{name: "styles.css", type: "file", url: "automerge:ghi789"},
			],
		}) as A.Doc<DirectoryDocument>
	})

	it("does not throw when some entries are unchanged", () => {
		// Update only 1 of 3 entries — the other 2 are unchanged and must be
		// spread into plain objects to avoid the Automerge proxy reinsert error.
		const newUrl = "automerge:newurl123" as AutomergeUrl
		doc = A.change(doc, d => {
			nukeAndRebuildDocs(
				d,
				"dist",
				[],
				[{name: "index.js", url: newUrl}],
				[],
				[],
			)
		})

		expect(doc.docs).toHaveLength(3)
		expect(doc.docs[0].name).toBe("index.js")
		expect(doc.docs[0].url).toBe(newUrl)
		expect(doc.docs[1].name).toBe("utils.js")
		expect(doc.docs[1].url).toBe("automerge:def456")
		expect(doc.docs[2].name).toBe("styles.css")
		expect(doc.docs[2].url).toBe("automerge:ghi789")
	})

	it("handles deletes mixed with unchanged entries", () => {
		doc = A.change(doc, d => {
			nukeAndRebuildDocs(d, "dist", [], [], ["utils.js"], [])
		})

		expect(doc.docs).toHaveLength(2)
		expect(doc.docs[0].name).toBe("index.js")
		expect(doc.docs[1].name).toBe("styles.css")
	})

	it("handles new entries alongside unchanged entries", () => {
		const newUrl = "automerge:new999" as AutomergeUrl
		doc = A.change(doc, d => {
			nukeAndRebuildDocs(
				d,
				"dist",
				[{name: "app.js", url: newUrl}],
				[],
				[],
				[],
			)
		})

		expect(doc.docs).toHaveLength(4)
		expect(doc.docs[3].name).toBe("app.js")
		expect(doc.docs[3].url).toBe(newUrl)
	})
})
