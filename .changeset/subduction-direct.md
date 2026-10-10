---
"pushwork": major
---

Sync with Subduction directly instead of through automerge-repo

- Storage moves to `.pushwork/storage/` in the sedimentree layout and config is version 6. `pushwork migrate` upgrades an old repo in place: it keeps the old `.pushwork` in `.pushwork/pushwork_migration_backup_safe_to_delete/` and fetches the repo from the server, pushing nothing until the next `sync`.
- New `pushwork track <url> [dir]` follows a URL from an existing directory without touching its files, and `pushwork merge <url> [dir]` joins the two, keeping files from both sides (local wins).
- The legacy sync3 backend is gone, along with `--legacy` and `--no-sub`. Repos still on it have to be re-initialized.
- The sync server is set per repo with `--sync-server <url>` on `init`, `clone`, `track`, `merge`, `migrate`, `yoink` and `yeet`. Keyhive repos also record their keyhive server, chosen with `--keyhive-server` and `--keyhive-card`, and can keep their data on a different sync server. `init --offline` skips the network.
- Every environment variable except `DEBUG` is removed (`PUSHWORK_SUBDUCTION_SERVER`, `PUSHWORK_LEGACY_SERVER`, `PUSHWORK_KEYHIVE_SERVER`, `PUSHWORK_HOME`, `PUSHWORK_WS_INLINE`, `PUSHWORK_SHUTDOWN_MS`).
- Keyhive is opt-in with `init --keyhive`. `--public-access` and `--server-access` (`relay`, `read`, `edit` or `admin`) say what anyone and the server may do; without `--public-access` only you can read the repo. The old `keyhive` subcommands (`use`, `status`, `list`, `grant`), `--no-keyhive` and `--no-world-read` are gone. `pushwork keyhive` shows the keyhive server and your contact card, and `pushwork keyhive server <name>` or `pushwork keyhive server <url> <card>` chooses the server (built-in `keyhive` and `subduction`, or any url with its contact card).
- Shapes deal in files: `encode({ docs, files, previousRoot, title, isArtifact, fresh })` turns a map of posix path to bytes into a root doc, and `decode({ docs, root })` returns the files. Whether each file gets a doc of its own is up to the shape, so a shape can keep files inline (see `examples/shapes/slay.js`). Shapes take a `Docs` instance in place of a `Repo`, and roots are URLs in place of `DocHandle`s.
- `sync` reports SYNCED, PENDING (with the documents the server hasn't confirmed) or OFFLINE. The library's `sync` returns that report, and `RepoSummary` no longer has `backend` or keyhive fields.
- `clone` no longer follows legacy Patchwork "branches" documents.
- New `pushwork shape install <file|url|automerge-url>`, `shape list` and `shape remove` manage shapes in `~/.pushwork/shapes/`, so `--shape <name>` works and a repo's config records the name instead of a path.
