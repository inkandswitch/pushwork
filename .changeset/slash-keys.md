---
"pushwork": patch
---

Fix syncing edits to JSON documents with keys containing "/", such as Jupyter notebook outputs (`image/png`, `text/plain`), which failed with "invalid path".
