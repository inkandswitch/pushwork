---
"pushwork": patch
---

Keep a held-back fragment's commits on disk as loose commits until the fragment is stored, so closing before a sync no longer loses the last changes; remember across runs which fragment heads the server holds, so fragments are stored and compacted offline; and compact docs whose head closes a fragment
