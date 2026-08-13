# Pinned Links and Artifacts

These used to be one concept ("artifact directories") and are now two:

1. **Every link is pinned.** Every file and folder link a folder doc carries
   is a heads-pinned URL. This is universal and not configurable.
2. **`artifact` is a content attribute.** A path marked `artifact` stores its
   text content as an atomic, last-writer-wins `ImmutableString` instead of a
   merge-able CRDT text. Configured per folder via `.pushworkattributes`.

## Universal pinning

```
folder doc (root)          ← tracked by its bare URL (automerge:root)
  ├── "src"  → automerge:abc#h1|h2          (pinned folder link)
  │     └── "app.ts" → automerge:jkl#h5     (pinned file link)
  └── "dist" → automerge:def#h3             (pinned folder link)
        └── "cli.js" → automerge:ghi#h4     (pinned file link)
```

A pinned URL (`documentId` + heads, `pinUrl(handle)`) names an exact,
immutable version. Because *every* link is pinned:

- **A URL is a version.** Anyone holding a link from a folder doc sees the
  content that was published there, forever — no cache-staleness, and the
  folder doc's history is a version history of the whole tree.
- **The pin is the merge base.** Sync materialized disk from the pins, so at
  rest disk == pin. The next sync uses the pinned content as the base of a
  three-way reconcile (see [sync](./sync.md)) — no separate snapshot state.
- **Syncing is publishing.** `sync`/`save` re-pin every link at the heads
  they can see, so whatever has reached local storage becomes the published
  version.

Only the *root* folder URL stays bare: the repo is tracked by identity, not
by version, and config load strips heads off it anyway (a pinned root would
yield a view-only handle that throws on edit).

Pins move only when content does: `syncFolder` skips the folder-doc write
when the link array is unchanged, so an untouched subtree keeps its exact
pin — and therefore its parents keep theirs.

Consequently a changed file gets fresh content and a _new pinned link_ in its
folder doc; readers holding the old pinned URL keep a consistent view of the
old snapshot. Writers must strip heads first (`stripHeads`) — opening a
pinned URL yields a view-only handle.

## The `artifact` attribute

Character-level CRDT merging of machine-generated files is expensive and
meaningless. Marking a path `artifact` makes its valid-UTF-8 content an
`ImmutableString` — replaced whole, never character-merged (binary content is
`Uint8Array` and always behaves this way; see [`shapes`](./shapes.md)).

Configuration is gitattributes-style: a `.pushworkattributes` file may sit in
**any directory**, its patterns relative to its own location and scoped to
its own subtree. Deeper files override shallower ones for the paths they
match; within a file, the last matching rule wins. `-artifact` unsets.

```
# tool-a/.pushworkattributes
dist/**   artifact
*.wasm    artifact
vendored/ -artifact
```

Attributes files are ordinary tracked files, so every clone sees the same
rules. When any artifact rule exists in the tree, the local
`.pushwork/config.json` `artifactDirectories` list (default `["dist"]`) is
ignored (with a warning if it's non-empty); it remains only as the fallback
for repos that carry no attributes files.

## History

- v1 used `RawString` content, SHA-256 `contentHash` change detection, and
  "nuclear" rebuilds of directory docs — a recurring source of
  deletion-resurrection bugs.
- v2 expressed artifact-ness as heads-pinned links *plus* ImmutableString
  content, but only for configured artifact directories, with a root-only
  attributes file. Pinning some links and not others meant most URLs were
  mutable references and a pre-refresh server wait tried to pin "the merged"
  heads.
- v3 (current) pins everything, always, and reduces `artifact` to the
  content-encoding attribute described above. The extra server wait is gone:
  pins deliberately capture the local heads — publish what you have.
