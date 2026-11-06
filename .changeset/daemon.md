---
"pushwork": minor
---

Run commands in a background daemon that keeps one connection open per sync server

- `pushwork daemon status` shows the daemon's pid, version, connected servers, socket and log, or what it is busy with when it doesn't answer; `pushwork daemon stop` stops it once running commands finish.
- `--no-daemon` runs a command in its own process and stops the daemon if it is running; so does the library API, once per process.
- A command waits for a daemon that is busy with another terminal's command rather than kill it; Ctrl-C cancels a command in the daemon at its next step.
- The daemon logs to `~/.pushwork/daemon.log`, keeping the last one's as `daemon.log.1`; it exits after 10 minutes idle and is replaced when pushwork is rebuilt or upgraded.
