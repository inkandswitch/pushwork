# Artifact Directories

Build-output directories (default: `["dist"]`, configurable via `artifactDirectories`) contain machine-generated files. Character-level CRDT merging of generated code is expensive and meaningless — artifacts should behave as immutable snapshots, not collaborative text.

## Mechanism: Immutability in the Link Layer

Artifactiness is expressed with **heads-pinned URLs** rather than content conventions:

```
folder doc (root)
  ├── "src"  → automerge:abc                (plain URL — live subtree)
  └── "dist" → automerge:def?heads=[h1,h2]  (pinned URL — frozen subtree)
        └── "cli.js" → automerge:ghi?heads=[...]  (pinned file link)
```

- **File links** inside an artifact directory are pinned (`pinUrl(handle)` = documentId + current heads).
- **Folder links** for artifact directories are pinned too, so the entire subtree reads as frozen from the parent. This is driven by the `isArtifactDir(posixPath)` classifier threaded into `Shape.encode` — _not_ inferred from children, which would spuriously freeze a plain parent whose only child happens to be an artifact subdir.
- **File content** in artifacts is stored atomically: valid UTF-8 becomes `ImmutableString`, binary stays `Uint8Array` — both last-writer-wins, never character-merged (see [`shapes`](./shapes.md)).

## Changing an Artifact

A changed artifact file gets fresh content and a _new pinned link_ written into its folder doc; readers holding the old pinned URL keep a consistent view of the old snapshot. Opening a pinned URL yields a view-only handle — which is why the repo's root URL is always heads-stripped on config load (a pinned root would throw on edit).

## History

The v1 design used `RawString` content, SHA-256 `contentHash` change detection, and "nuclear" rebuilds of directory docs — a recurring source of deletion-resurrection bugs. Pinning heads in the link layer supersedes all of that: immutability is a property of the reference, not a bookkeeping protocol.
