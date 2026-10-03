# Config

Per-repo configuration lives at `.pushwork/config.json`; document storage lives at `.pushwork/storage/`.

## Format (version 6)

```json
{
	"version": 6,
	"rootUrl": "automerge:...",
	"shape": "vfs",
	"artifactDirectories": ["dist"],
	"server": "ws://localhost:8080"
}
```

| Field | Meaning |
| --- | --- |
| `version` | Config schema version (`CONFIG_VERSION`) |
| `rootUrl` | The repo's identity: the root doc URL |
| `shape` | Document layout: `"vfs"`, `"patchwork-folder"`, or a custom module path (see [`shapes`](./shapes.md)) |
| `artifactDirectories` | Frozen subtrees (see [`artifacts`](./artifacts.md)) |
| `server` | Optional. The sync server, when it isn't the default |

Whether a repo is keyhive-protected follows from its root id: protected ids are 32 bytes, plain ones 16. Its keyhive group isn't stored either; it's read from the root document's members in the local keyhive state.

`readConfig` strips heads from `rootUrl`, because the root is always opened live so sync can change it.

## Older versions

A config with any other version throws, pointing at `pushwork migrate`. `readOldConfig` reads the root URL, shape and artifact directories from every earlier layout (the original pushwork's `root_directory_url` or `snapshot.json`, and pushwork 2's versions 1–5). `migrate` then:

1. moves everything in `.pushwork/` to `.pushwork/pushwork_migration_backup_safe_to_delete/`, since the old storage can't be read without automerge-repo;
2. tracks the root URL, as `pushwork track` does, writing a current config and fetching the tree into fresh storage;
3. puts everything back if the fetch fails.

It pushes nothing. The fetched tree becomes the saved state, so `status` shows how the working tree differs from the server, and the next `sync` publishes those differences. Repos on the retired sync3 server can't be fetched and are told to `rm -rf .pushwork && pushwork init`.

## Changing the format

Bump `CONFIG_VERSION`, change `PushworkConfig`, and decide what `readConfig` tells users of the previous version.
