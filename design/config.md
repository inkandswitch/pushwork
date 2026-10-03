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
| `publishGroup` | Optional. The keyhive group of a tree made with `init --publish` |

Whether a repo is keyhive-protected follows from its root id: protected ids are 32 bytes, plain ones 16.

`readConfig` strips heads from `rootUrl`, because the root is always opened live so sync can change it.

## Older versions

There is no migration. A config with any other version throws with instructions:

- Repos on the retired sync3 server are told to `rm -rf .pushwork && pushwork init`, which republishes the directory as a new repo.
- Everything else is told to run `npx pushwork@2 sync` to publish local edits, then `pushwork clone <rootUrl> <newdir> --shape <shape>`, with the URL and shape filled in.

Re-cloning instead of converting in place means a stale working tree can never overwrite newer data on the server.

## Changing the format

Bump `CONFIG_VERSION`, change `PushworkConfig`, and decide what `readConfig` tells users of the previous version.
