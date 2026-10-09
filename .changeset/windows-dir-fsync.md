---
"pushwork": patch
---

Don't fsync directories on Windows, where it fails with EPERM and broke every save
