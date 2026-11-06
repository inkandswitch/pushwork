---
"pushwork": minor
---

Run commands in a background daemon that keeps one connection open per sync server

- `pushwork daemon status` shows the daemon's pid, version, connected servers, socket and log; `pushwork daemon stop` stops it once running commands finish.
- `--no-daemon` runs a command in its own process and stops the daemon if it is running.
- The daemon logs to `~/.pushwork/daemon.log`; it exits after 10 minutes idle and is replaced when pushwork is rebuilt or upgraded.
