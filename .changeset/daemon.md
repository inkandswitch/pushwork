---
"pushwork": minor
---

Run commands in a background daemon per home, which keeps server connections open between commands and is restarted when pushwork is rebuilt or upgraded; `pushwork daemon status` and `pushwork daemon stop` show and stop it, and `--no-daemon` runs a command in its own process
