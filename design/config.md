# Config & Migrations

Per-repo configuration lives at `.pushwork/config.json`; CRDT storage lives at `.pushwork/storage/`.

## Current Format (version 4)

```json
{
	"version": 4,
	"rootUrl": "automerge:...",
	"backend": "subduction",
	"shape": "patchwork-folder",
	"artifactDirectories": ["dist"]
}
```

| Field | Meaning |
| --- | --- |
| `version` | Config schema version (`CONFIG_VERSION`) |
| `rootUrl` | The repo's identity — the root folder doc URL |
| `backend` | `"subduction"` (default) or `"legacy"` WebSocket relay |
| `shape` | Document layout: `"patchwork-folder"`, `"vfs"`, or a custom module path (see [`shapes`](./shapes.md)) |
| `artifactDirectories` | Frozen subtrees (see [`artifacts`](./artifacts.md)) |

## Strict Versioning

`readConfig` **hard-errors** on any version mismatch and directs the user to `pushwork migrate`. There is no duck-typing and no in-memory tolerance of old shapes — downstream code only ever sees the current format.

One normalization does happen on every load: `rootUrl` is heads-stripped. Older migrated configs sometimes stored a pinned root URL; carrying the heads forward would yield a view-only handle that throws on edit. The documentId (the repo's identity) is preserved.

## Migration Chain

`pushwork migrate` walks any older config forward one version at a time:

```
"-"  ──►  1  ──►  2  ──►  3  ──►  4
```

| Version | Shape |
| --- | --- |
| `"-"` | Original (pre-v2) pushwork: `DirectoryConfig` `{sync_server, sync_enabled, root_directory_url, subduction, artifact_directories, ...}`; storage in `.pushwork/automerge/` + `snapshot.json` |
| 1 | First pushwork@2 layout, no `version` field: `{rootUrl, backend}`; storage in `.pushwork/storage/` |
| 2 | Adds `version: 2`, `shape`, `artifactDirectories` |
| 3 | Adds `branches: boolean` |
| 4 | Drops `branches` (current) |

Each step is a small, pure-ish transform. Only the `"-"` → 1 step touches the filesystem (it relocates the storage directory); the rest reshape JSON.

## Adding a Version

1. Bump `CONFIG_VERSION` in `config.ts` and adjust `PushworkConfig`.
2. Add one `Migration` step (`from: N, to: N+1`) in `migrations.ts`.
3. Never edit existing steps — old configs must still walk the full chain.
