---
"pushwork": major
---

Sync with Subduction directly instead of through automerge-repo

- Storage moves to `.pushwork/storage/` in the sedimentree layout and config is version 6. Older repos are not migrated: sync them with `npx pushwork@2 sync`, then re-clone. `pushwork migrate` is gone.
- The legacy sync3 backend is gone, along with `--legacy` and `--no-sub`. Repos still on it have to be re-initialized.
- The server is set per repo with `--server <url>` on `init`, `clone`, `yoink` and `yeet`. `init --offline` skips the network.
- Every environment variable except `DEBUG` is removed (`PUSHWORK_SUBDUCTION_SERVER`, `PUSHWORK_LEGACY_SERVER`, `PUSHWORK_KEYHIVE_SERVER`, `PUSHWORK_HOME`, `PUSHWORK_WS_INLINE`, `PUSHWORK_SHUTDOWN_MS`).
- Keyhive is reduced to `init --publish`, which makes a tree that everyone can read and only you can write. The `keyhive` command group, `--no-keyhive` and `--no-world-read` are gone.
- Shapes take a `Docs` instance in place of a `Repo`, and roots are URLs in place of `DocHandle`s. `pinUrl` is replaced by `docs.pin`.
- `sync` reports SYNCED, PENDING (with the documents the server hasn't confirmed) or OFFLINE. The library's `sync` returns that report, and `RepoSummary` no longer has `backend` or keyhive fields.
- `clone` no longer follows legacy Patchwork "branches" documents.
