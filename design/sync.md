# Sync

## Flow

`pushwork sync` is a commit + reconcile against the sync server:

```mermaid
sequenceDiagram
    participant W as Working dir
    participant L as Local repo (.pushwork/storage)
    participant S as Sync server

    Note over L,S: 1. Open repo, start connection wait (overlapped)
    W->>L: walk tree, three-way reconcile against the local bases
    L->>L: encode: write changed links (shape.encode)
    S-->>L: remote commits arrive as docs are found
    L->>W: materialize the tree to disk (atomic), record new bases
    Note over L,S: 2. waitForServerSync on the root folder doc
    L->>S: push un-broadcast commits
    S-->>L: advertise heads back
    Note over L,S: 3. Verdict: SYNCED / PENDING / timeout
```

Key properties:

- `repo.find` is what triggers delivery — every file leaf is touched so the network layer announces it to peers.
- The connection wait (`waitForConnection`) starts immediately after `openRepo` so local tree work overlaps the Subduction handshake.
- Big fresh clones/ingests shard across worker threads (`ingest-pool.ts`) past a size threshold.

## The local merge base

Links are live (see [artifacts](./artifacts.md)), so the base is kept per
clone in `.pushwork/bases.json`: for each path, the pinned URL of the version
last materialized to disk. Sync maintains the invariant that **at rest, disk
== the content at the recorded bases**: `sync`, `save`, `clone` and `cut`
record the heads they just materialized, `init` and `nuclearize` record what
they read off disk. Every sync re-anchors the bases, so the arrangement
self-heals. A recorded base only applies while it names the same document as
the link; otherwise the link itself is the base, which is how a link pinned
by an older pushwork still serves as the base on its first sync.

`pushFiles` reconciles each path as: **base** = the recorded base's content
(what `readLeaves` decodes, by construction), **disk** = the working-tree
bytes, **tip** = the live doc (heads stripped). For a
[JSON document](./shapes.md#json-documents) "equal" means equal JSON values,
not bytes, and the edit is a structural `patchJson` rather than
`applyFileEntry`; the cases are otherwise the same:

| Case | Action |
| --- | --- |
| disk == base | Nothing to record; an edit that arrived in local storage (e.g. from the browser) gets materialized. |
| tip == disk | The edit is already in the doc (our own earlier merge, or a peer wrote the same bytes): skip the write. Recording it again at the base would land the identical splice twice — Automerge does not dedupe concurrent duplicates. |
| tip == base | A plain local edit: `applyFileEntry` at the tip. |
| all three differ | `handle.changeAt(baseHeads, ...)`: the callback sees the doc *at base*, so the disk diff lands as a change **concurrent** with the tip's, and the two merge instead of the disk diff undoing the tip's edits. |
| no base heads | No recorded base and a bare link: `applyFileEntry` at the tip. |

Deletes and creates are unchanged: present in base but gone from disk is a
delete, on disk but absent from base is a create. A JSON document whose disk
copy doesn't parse as an object is _held_: it keeps its old base, sync warns,
and materialize leaves the file alone, so a half-typed edit is never
overwritten; the next sync after it parses reconciles against the old base.
After the reconcile: encode, stamp, one `waitForServerSync`, final decode,
materialize, record bases — leaving base == tip == disk.

Two consequences, stated as behaviour rather than bugs:

- **Syncing materializes the tip it can see**, including a peer's edits
  that already reached local storage.
- **`patchwork-folder` link lists are last-writer-wins** (`d.docs` is
  replaced wholesale), so two writers adding entries to the same folder
  concurrently can drop one side's additions. Content edits don't touch the
  folder doc, so they never race this way.

## The Sync Verdict

The CLI must not claim SYNCED unless the server demonstrably has our data. `syncVerdict` (in `repo.ts`) judges against the _server's_ advertised state, not a local-settle heuristic:

| Condition | Meaning |
| --- | --- |
| _local-quiet_ | Our heads haven't changed for `idleMs` (local writes flushed) |
| _pull-complete_ | We hold every commit the server advertised (`containsHeads`) |
| _push-confirmed_ | The server advertised our current frontier back to us |

```
SYNCED  = local-quiet ∧ pull-complete ∧ push-confirmed
PENDING = local-quiet ∧ pull-complete ∧ ¬push-confirmed
```

> [!NOTE]
>
> Server heads are Subduction _sedimentree_ heads (loose-commit and fragment-boundary ids), NOT the Automerge frontier — they are never compared to `handle.heads()` for equality. Pull-completeness asks "do we already contain everything advertised?"; push-confirmation asks "is our frontier a subset of what the server advertises?".

### Known false negative

A server that compacts our change into a fragment may re-advertise it under a different id, so push-confirmation fails and the CLI shows PENDING even though the data landed. This is deliberate — a conservative false-PENDING replaced the old false-SYNCED. Only a server-ack (`awaitSynced()`-style) API in automerge-repo closes the gap completely.

### Stuck-doc nudge

If we're behind for `resyncAfterMs` (default 6 s) and the scheduler isn't catching us up, `waitForServerSync` re-arms a single fresh sync round via `repo.resyncSubduction(documentId)` — once per document per run (`claimResync`).

## Backends

| Backend | Selection | Verdict basis |
| --- | --- | --- |
| Subduction (default) | unflagged | server-advertised heads (above) |
| Legacy WebSocket relay | `--legacy`/`--no-sub` | local head-stability settle only |

The backend is persisted per-repo in the config; both share the same `automerge-repo` API surface.

## Offline Commands

`save`, `status`, `diff`, `heads`, `cut`/`paste`, and `nuclearizeRepo` open the repo offline (`openRepo(..., { offline: true })`) and never contact the server; the next online `sync` publishes whatever they produced.
