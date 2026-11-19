---
"pushwork": patch
---

Folder and file links are live URLs again; only artifact files are linked pinned to heads. Pinning every link made Patchwork open every document from a synced folder read-only. The three-way merge base now lives per checkout in `.pushwork/bases.json`. A link pinned by an earlier version still serves as the base on its first sync, which rewrites it live.
