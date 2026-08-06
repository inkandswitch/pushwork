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
		repo: Repo
		tree: VfsNode
		previousRoot?: DocHandle<unknown> // mutate in place vs. create fresh
		title?: string
		isArtifactDir?: (posixPath: string) => boolean // see artifacts.md
	}): Promise<AutomergeUrl>

	decode(args: {repo: Repo; root: DocHandle<unknown>}): Promise<VfsNode>
}
```

- `encode` with `previousRoot` mutates the existing root doc in place — the root URL is the repo's identity and must be preserved.
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

Text updates go through `Automerge.updateText` so concurrent character-level edits converge; bytes and `ImmutableString` are last-writer-wins.

## Builtin Shapes

### `patchwork-folder` (default)

One folder doc per directory, interoperable with Patchwork:

```ts
{
  "@patchwork": { type: "folder" },
  title: string,
  docs: [{ name, type, url, icon? }, ...],
  lastSyncAt?: number,
}
```

- Subfolders are linked by URL — plain for normal dirs, heads-pinned for artifact dirs.
- `type` is the file extension (or `"folder"`), used by Patchwork for icons.

### `vfs`

A single directory doc mapping slash-separated relative paths directly to file-doc URLs:

```ts
{
  "@patchwork": { type: "directory", title? },
  "src/cli.ts": "automerge:...",
  "README.md": "automerge:...",
}
```

Flat and cheap — one doc for the whole tree structure — at the cost of folder-level granularity and Patchwork folder interop.

## Custom Shapes

`resolveShape(name)` falls back to loading a module by path (`shapes/custom.ts`) for any non-builtin name. A custom shape module exports a `Shape`; the shape name is persisted per-repo in the config (see [`config`](./config.md)), so all peers of a repo agree on its layout.
