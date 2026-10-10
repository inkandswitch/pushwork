---
"pushwork": patch
---

Send each fragment's head to the server before the fragment itself, so the server sees which commits the fragment covers instead of keeping them all and sending them back after compaction
