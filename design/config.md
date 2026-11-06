# Config

Per-repo configuration lives at `.pushwork/config.json`. Documents live in one store per machine, `~/.pushwork/storage/`, shared by every checkout. Each checkout keeps `.pushwork/heads.json` and `.pushwork/checkout.lock` of its own.

## Format (version 7)

```json
{
	"version": 7,
	"rootUrl": "automerge:...",
	"shape": "vfs",
	"artifactDirectories": ["dist"],
	"syncServer": "ws://localhost:8080"
}
```

| Field | Meaning |
| --- | --- |
| `version` | Config schema version (`CONFIG_VERSION`) |
| `rootUrl` | The repo's identity: the root doc URL |
| `shape` | Document layout: `"vfs"`, `"patchwork-folder"`, or a custom module path (see [`shapes`](./shapes.md)) |
| `artifactDirectories` | Frozen subtrees (see [`artifacts`](./artifacts.md)) |
| `syncServer` | Optional. Where document data syncs, when it isn't the default (for keyhive repos, the keyhive server) |
| `keyhiveServer` | Keyhive repos. The keyhive server, a built-in name or url, recorded at init or clone |
| `keyhiveCard` | Keyhive repos with a custom server. Its contact card |
| `keyhiveVersion` | Keyhive repos. The automerge-repo-keyhive version, `0.5` or `0.6`; unset means `0.5`. The two can't read each other's archives or talk to each other's servers |

Whether a repo is keyhive-protected follows from its root id: protected ids are 32 bytes, plain ones 16. Its keyhive group isn't stored either; it's read from the root document's members in the local keyhive state.

`readConfig` strips heads from `rootUrl`, because the root is always opened live so sync can change it. `writeConfig` writes `.pushwork/config.json.tmp` and renames it into place, so a crash leaves the old config whole.

## Checkout state

`.pushwork/heads.json` holds the heads this checkout last saw of each document:

```json
{ "version": 1, "heads": { "<documentId>": ["<hex>", "..."] } }
```

It is written to a temporary file and renamed into place, and only after the documents it names are saved to the store. Without it, every document is read live. A corrupt file is an error that says to delete it and run `pushwork sync`.

`.pushwork/checkout.lock` holds the pid of the process using the checkout. A second command fails and names that pid; a lock left by a dead process is taken over. `status`, `diff` and `heads` don't take it; everything else that opens a repo does.

## Older versions

A config with any other version throws, pointing at `pushwork migrate`.

### Version 6

`migrate` on a version 6 repo works offline:

1. imports `.pushwork/storage` into `~/.pushwork/storage`, converting the old flat `sent/` files to one directory per server;
2. writes `heads.json`, with each document's heads as the checkout's own storage had them, so newer versions another checkout already put in the machine store aren't taken for this one's;
3. moves the old storage to `.pushwork/pushwork_migration_backup_safe_to_delete/storage-v6`;
4. writes config version 7.

If any step fails, it rolls back to a working version 6 repo. A version 6 checkout rooted at the home directory, whose `.pushwork/storage` is the machine store, is converted in place. Its heads are the store's live heads, so if another checkout already put newer versions of its documents there, they can't be told apart from its own: `status` shows the difference as local changes, and the next `save` or `sync` would undo them. Check `status` after migrating it. `migrate --sync-server` on a version 6 repo records that server.

### Earlier versions

`readOldConfig` reads the root URL, shape and artifact directories from every earlier layout (the original pushwork's `root_directory_url` or `snapshot.json`, and pushwork 2's versions 1–5). `migrate` then:

1. moves everything in `.pushwork/` to `.pushwork/pushwork_migration_backup_safe_to_delete/`, since the old storage can't be read without automerge-repo;
2. tracks the root URL, as `pushwork track` does, writing a current config and fetching the tree into fresh storage;
3. puts everything back if the fetch fails.

A repo rooted at the home directory is refused before anything moves: its `.pushwork` is also the machine's, holding the key and the store. It has to be moved out of the home directory and migrated there.

It pushes nothing. The fetched tree becomes the saved state, so `status` shows how the working tree differs from the server, and the next `sync` publishes those differences. Repos on the retired sync3 server can't be fetched and are told to `rm -rf .pushwork && pushwork init`.

## Changing the format

Bump `CONFIG_VERSION`, change `PushworkConfig`, and decide what `readConfig` tells users of the previous version.
