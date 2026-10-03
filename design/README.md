# Pushwork Design

This directory contains design documents for pushwork: how a directory tree is mapped onto Automerge documents, how sync verdicts are reached, and how local state is managed.

## Documents

| Document | Purpose |
| --- | --- |
| [`shapes`](./shapes.md) | The Shape abstraction: encoding a directory tree as docs |
| [`sync`](./sync.md) | Sync flow, server sync verdicts (SYNCED / PENDING) |
| [`artifacts`](./artifacts.md) | Artifact directories as heads-pinned, immutable subtrees |
| [`config`](./config.md) | The config file, and what happens to old versions |
| [`snarf`](./snarf.md) | Offline stash: `cut` / `paste` / `snarfs` |

## Layers

```mermaid
block-beta
    columns 1
    CLI["CLI<br/>(commander + clack)"]
    Commands["Commands<br/>(init · clone · sync · save · status · diff · yoink · yeet · cut · paste)"]
    Shapes["Shapes<br/>(VfsNode ⇄ Automerge docs)"]
    Docs["Docs<br/>(find · create · change · save · sync · compact)"]
    Subduction["Subduction<br/>(FsStorage · one server connection)"]
```

## Core Model

Every pushwork repo is a tree of Automerge documents rooted at a single folder document, addressed by a shareable `automerge:` URL:

```
automerge:<root>                      ← the repo's identity
  ├── folder doc "src"
  │     ├── file doc "cli.ts"
  │     └── file doc "docs.ts"
  ├── folder doc "dist"  (heads-pinned ⇒ frozen artifact subtree)
  │     └── file doc "cli.js"  (heads-pinned link)
  └── file doc "README.md"
```

Sync is a decode → diff → encode cycle:

1. _Decode_ the saved tree (via the configured [shape](./shapes.md)) into an in-memory `VfsNode` tree.
2. _Diff_ against the working directory (byte comparison, atomic writes).
3. _Encode_ local changes back into documents, sync them, and report the [verdict](./sync.md).

## Design Principles

- **Shapes are pluggable** — the document layout is a strategy, not a hardcoded schema; `vfs` is the default and `patchwork-folder` interoperates with Patchwork.
- **The CRDT is the merge** — no conflict resolution UI; concurrent edits converge via Automerge.
- **Honest verdicts** — the CLI only prints SYNCED when a sync round with the server for every document had nothing left to exchange; otherwise PENDING.
- **Immutability in the link layer** — artifact subtrees are frozen by pinning heads in URLs, not by content conventions.
- **Strict config versioning** — other config versions hard-error with instructions to re-clone; nothing is converted in place.
- **Offline-first** — `save`, `status`, `diff`, `heads`, `cut`/`paste` all work without a network connection.
