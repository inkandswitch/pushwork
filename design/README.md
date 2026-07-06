# Pushwork Design

This directory contains design documents for pushwork: how a directory tree is mapped onto Automerge documents, how sync verdicts are reached, and how local state is managed.

## Documents

| Document | Purpose |
| --- | --- |
| [`shapes`](./shapes.md) | The Shape abstraction: encoding a directory tree as docs |
| [`sync`](./sync.md) | Sync flow, server sync verdicts (SYNCED / PENDING) |
| [`artifacts`](./artifacts.md) | Artifact directories as heads-pinned, immutable subtrees |
| [`config`](./config.md) | Versioned config and stepwise migrations |
| [`snarf`](./snarf.md) | Offline stash: `cut` / `paste` / `snarfs` |

## Layers

```mermaid
block-beta
    columns 1
    CLI["CLI<br/>(commander + clack)"]
    Commands["Commands<br/>(init · clone · sync · save · status · diff · yoink · yeet · cut · paste)"]
    Shapes["Shapes<br/>(VfsNode ⇄ Automerge docs)"]
    Repo["Repo<br/>(open · shutdown · connection · sync verdicts)"]
    Backend["Backend<br/>(Subduction · legacy WebSocket relay)"]
```

## Core Model

Every pushwork repo is a tree of Automerge documents rooted at a single folder document, addressed by a shareable `automerge:` URL:

```
automerge:<root>                      ← the repo's identity
  ├── folder doc "src"
  │     ├── file doc "cli.ts"
  │     └── file doc "repo.ts"
  ├── folder doc "dist"  (heads-pinned ⇒ frozen artifact subtree)
  │     └── file doc "cli.js"  (heads-pinned link)
  └── file doc "README.md"
```

Sync is a decode → diff → encode cycle:

1. _Decode_ the remote tree (via the configured [shape](./shapes.md)) into an in-memory `VfsNode` tree.
2. _Diff_ against the working directory (byte comparison, atomic writes).
3. _Encode_ local changes back into documents and wait for the [server sync verdict](./sync.md).

## Design Principles

- **Shapes are pluggable** — the document layout is a strategy, not a hardcoded schema; `patchwork-folder` (the default) interoperates with Patchwork.
- **The CRDT is the merge** — no conflict resolution UI; concurrent edits converge via Automerge.
- **Honest verdicts** — the CLI only prints SYNCED when the server has demonstrably received our changes; otherwise PENDING.
- **Immutability in the link layer** — artifact subtrees are frozen by pinning heads in URLs, not by content conventions.
- **Strict config versioning** — unknown config versions hard-error and point at `pushwork migrate`; migrations are small stepwise transforms.
- **Offline-first** — `save`, `status`, `diff`, `heads`, `cut`/`paste` all work without a network connection.
