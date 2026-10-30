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
	}): Promise<AutomergeUrl>

	decode(args: {repo: Repo; root: DocHandle<unknown>}): Promise<VfsNode>
}
```

- `encode` with `previousRoot` mutates the existing root doc in place — the root URL is the repo's identity and must be preserved.
- The tree's file leaves arrive with heads-pinned URLs, and shapes that represent directories as their own docs pin those folder links too (see [`artifacts`](./artifacts.md)); only the root URL stays bare.

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

## JSON Documents

A leaf that isn't a `UnixFileEntry` is a _JSON document_: the file's own object, stored as Automerge maps and lists (`src/shapes/json.ts`). `leafContent` tells the two apart by shape — a doc with `content` and an `@patchwork.type` of `"file"` (or none) is a file entry — so every reader handles both whatever its config says.

The config flag `jsonDocuments` only decides what a _new_ path becomes. A `.json` file qualifies (`jsonDocumentOf`) when it parses to an object whose `@patchwork` is an object with a `type` other than `"file"`. With the flag on, a qualifying path tracked as text is converted: a new JSON document, a new URL.

- **Writes** go through `patchJson`, a structural diff against the doc's current value: removed keys are deleted, strings spliced with `updateText`, arrays keep their common prefix and suffix and pair up the middle. Concurrent edits to different keys merge.
- **Reads** use the doc's plain JSON value (`jsonValueOf`): text becomes strings, counters numbers, dates ISO strings.
- **Layout.** Automerge sorts map keys and keeps no whitespace, so the bytes on disk can't be derived from the doc. `formatJson(value, template)` serializes with the indent, line endings, trailing newline and key order of `template` — the file currently on disk — appending keys it doesn't have. With no template it writes two-space indent and a trailing newline.
- **Link type.** `patchwork-folder` links a JSON document by its `@patchwork.type` (`jsonLinkType`), so Patchwork opens it with the matching tool. `file`, `folder`, `directory` and `branches` are reserved: a doc claiming one is linked by extension, since a `folder` link would be decoded as a subdirectory.

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

- Subfolders are linked by heads-pinned URL, like every other link; the doc write is skipped when the links are unchanged so pins only move when content does.
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
