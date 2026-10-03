# Shapes

A _shape_ is how a tree of files is laid out as Automerge documents. The rest of pushwork only deals in files, posix path to bytes; a shape maps those to a root document and back.

```
                    encode
  files by path  ───────────────►  Automerge docs (rooted at one URL)
                 ◄───────────────
                    decode
```

## The `Shape` Interface

```ts
type File = {bytes: Uint8Array; url?: AutomergeUrl} // url: the file's own doc, if it has one

interface Shape {
	encode(args: {
		docs: Docs
		files: Map<string, Uint8Array>
		previousRoot?: AutomergeUrl // change this root in place instead of creating one
		title?: string
		isArtifact?: (posixPath: string) => boolean // see artifacts.md
		fresh?: boolean // make every doc afresh instead of reusing those under previousRoot
	}): Promise<AutomergeUrl>

	decode(args: {docs: Docs; root: AutomergeUrl}): Promise<Map<string, File>>
}
```

`Docs` (`src/docs.ts`) is the whole document API a shape needs: `find`, `create`, `change`, `heads`, `pin`, and `updateText` (Automerge's, so a shape module doesn't need its own copy of Automerge).

- `encode` always gets the whole tree. With `previousRoot` it changes the existing root doc in place, because the root URL is the repo's identity; pushwork doesn't call it when no file changed.
- `isArtifact` classifies repo-relative posix paths, files and directories. Shapes that link documents pin artifact links to their current heads, so the subtree reads as frozen (see [`artifacts`](./artifacts.md)). After a sync, pushwork encodes the saved files again so pins catch up with heads that sync brought in.
- `fresh` is `sync --nuclear`: keep the root, but stop reusing the docs under it.
- `decode`'s `url` is optional; `pushwork heads` lists it when a file has one.

Whether each file gets a document of its own is the shape's business. The builtin shapes do, through `writeFileDocs` / `readFileDocs` in `shapes/file-docs.ts`.

## File Documents

The builtin shapes keep each file in a Patchwork-compatible `UnixFileEntry` doc:

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

`resolveShape(name)` falls back to loading a module by path (`shapes/custom.ts`) for any non-builtin name. A custom shape module's default export is a `Shape`; the shape name is persisted per-repo in the config (see [`config`](./config.md)), so all peers of a repo agree on its layout.

`examples/shapes/slay.js` is one: a [slaygrounds](https://github.com/chee/slaygrounds) project keeps its files inline, as strings and bytes in nested objects under `src`, with no doc per file.
