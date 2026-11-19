# Links and Artifacts

1. **Links are live, artifacts are pinned.** Folder links and ordinary file
   links are bare URLs, so anyone opening them — Patchwork included — gets the
   live, editable document. File links under an `artifact` path are
   heads-pinned snapshots.
2. **`artifact` is a content attribute.** A path marked `artifact` stores its
   text content as an atomic, last-writer-wins `ImmutableString` instead of a
   merge-able CRDT text. Configured per folder via `.pushworkattributes`.

## Links

```
folder doc (root)          ← tracked by its bare URL (automerge:root)
  ├── "src"  → automerge:abc                (live folder link)
  │     └── "app.ts" → automerge:jkl        (live file link)
  └── "dist" → automerge:def                (live folder link)
        └── "cli.js" → automerge:ghi#h4     (pinned artifact link)
```

A pinned URL (`documentId` + heads, `pinUrl(handle)`) names an exact,
immutable version; opening one yields a view-only handle. Artifacts are
published that way: a changed artifact gets fresh content and a _new pinned
link_ in its folder doc, and readers holding the old URL keep a consistent
view of the old snapshot. Writers must strip heads first (`stripHeads`).

Everything else is linked live. Because a live link doesn't move when its
document changes, a content edit touches only the file doc: `syncFolder` and
the `vfs` encoder skip the folder-doc write when no entry changed.

The three-way merge base is therefore not in the link. Each clone records the
pinned version it last materialized per path in `.pushwork/bases.json` (see
[sync](./sync.md)).

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
  attributes file.
- v3 pinned every link and used the pin as the merge base. Patchwork opened
  every document from such a folder read-only.
- v4 (current) links live again, pins only artifacts, and keeps the merge
  base locally. A link pinned by v3 still serves as the base on its first
  sync, which rewrites it bare.
