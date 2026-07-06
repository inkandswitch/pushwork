# Snarfs

A _snarf_ is a stashed set of working-tree changes — pushwork's offline answer to `git stash`.

## Commands

| Command | Effect |
| --- | --- |
| `pushwork cut` | Snarf working-tree changes, then reset the tree to the saved (last-committed) state |
| `pushwork paste [id]` | Re-apply a snarfed change set (default: most recent) and remove it from the stash |
| `pushwork snarfs` | List snarfed change sets, newest first |

All three are offline — they never contact the sync server.

## Storage

Snarfs live in `.pushwork/snarf/index.json` as an append-only array:

```ts
interface Snarf {
	id: number
	name?: string
	createdAt: number // epoch ms
	entries: SnarfEntry[]
}

interface SnarfEntry {
	path: string // repo-relative posix path
	kind: "modified" | "added" | "deleted"
	contentBase64?: string // omitted for "deleted"
}
```

- Entries capture the _working-tree side_ of the diff against the saved state: full content for modified/added files (base64, so binary is safe), a bare tombstone for deletions.
- `cut` computes the diff the same way `status`/`diff` do (decode the doc tree, compare bytes), records it, then restores the saved state to disk.
- `paste` **refuses if the working tree has uncommitted changes** (run `pushwork save` or `pushwork cut` first), then re-applies entries to the working tree and consumes the snarf. It does not touch the Automerge docs — a subsequent `save`/`sync` commits them.

## Design Notes

- Snarfs are deliberately **not** CRDT documents: they are private, local, transient state. Putting them in the doc tree would sync your stash to every peer.
- Content is snapshotted whole (no delta encoding) — simple, robust for the expected sizes, and independent of the doc history.
