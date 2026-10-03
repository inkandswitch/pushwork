# Shapes

A _shape_ is a strategy for laying a directory tree out as Automerge documents. The rest of pushwork works against an in-memory `VfsNode` tree; shapes translate between that tree and a concrete document graph.

```
                encode
  VfsNode  ───────────────►  Automerge docs (rooted at one URL)
  (dir/file tree)  ◄───────
                decode
```

## The `Shape` Interface

```ts
interface Shape {
	encode(args: {
		docs: Docs
		tree: VfsNode
		previousRoot?: AutomergeUrl // change this root in place instead of creating one
		title?: string
		isArtifactDir?: (posixPath: string) => boolean // see artifacts.md
	}): Promise<AutomergeUrl>

	decode(args: {docs: Docs; root: AutomergeUrl}): Promise<VfsNode>
}
```

`Docs` (`src/docs.ts`) is the whole document API a shape needs: `find`, `create`, `change`, `heads` and `pin`.

- `encode` with `previousRoot` changes the existing root doc in place, because the root URL is the repo's identity. Values that haven't changed aren't rewritten, so an unchanged tree leaves the root's heads alone.
- `isArtifactDir` classifies repo-relative posix _directory_ paths; shapes that represent directories as their own docs pin those folder links with heads so the whole subtree reads as frozen (see [`artifacts`](./artifacts.md)).

## File Documents

All shapes share one leaf format, the Patchwork-compatible `UnixFileEntry`:

```ts
{
  "@patchwork": { type: "file" },
  content: string | Uint8Array | ImmutableString,
  extension: string,
  mimeType: string,
  name: string,
}
```

Content classification (`bytesToContent`):

| Bytes                        | Stored as                           |
| ---------------------------- | ----------------------------------- |
| Valid UTF-8, non-artifact    | `string` (mergeable Automerge text) |
| Valid UTF-8, artifact        | `ImmutableString` (atomic, LWW)     |
| Contains NUL / invalid UTF-8 | `Uint8Array` (atomic, LWW)          |

Leaves are updated with `docs.change(url, d => applyFileEntry(d, fresh))`. Text goes through `Automerge.updateText` so concurrent character-level edits converge; bytes and `ImmutableString` are last-writer-wins.

## Builtin Shapes

### `patchwork-folder`

One folder doc per directory, interoperable with Patchwork:

```ts
{
  "@patchwork": { type: "folder" },
  title: string,
  docs: [{ name, type, url, icon? }, ...],
}
```

- Subfolders are linked by URL — plain for normal dirs, heads-pinned for artifact dirs.
- `type` is the file extension (or `"folder"`), used by Patchwork for icons.

### `vfs` (default)

A single directory doc mapping slash-separated relative paths directly to file-doc URLs:

```ts
{
  "@patchwork": { type: "directory", title? },
  "src/cli.ts": "automerge:...",
  "README.md": "automerge:...",
}
```

Flat and cheap — one doc for the whole tree structure — at the cost of folder-level granularity and Patchwork folder interop. `lastSyncAt` is reserved: older pushwork wrote it, and it is never decoded as a file.

## Custom Shapes

`resolveShape(name)` falls back to loading a module by path (`shapes/custom.ts`) for any non-builtin name. A custom shape module exports a `Shape`; the shape name is persisted per-repo in the config (see [`config`](./config.md)), so all peers of a repo agree on its layout.
