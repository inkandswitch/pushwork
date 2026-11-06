# The daemon

Commands run in a background process, one per home directory, which keeps a connection open to each sync server between commands. A command that would otherwise dial the server, sync, and hang up instead asks the daemon, which is usually already connected.

`pushwork --no-daemon <command>` runs the command in its own process, and stops the daemon if one is running. `pushwork daemon status` shows the daemon's pid, version, start time, connected servers, socket and log; for a daemon that doesn't answer, the command it is busy with, or that it isn't answering. `pushwork daemon stop` asks it to stop once the commands it is running finish, however long they take; the next command starts it again. The hidden `pushwork daemon run` is what starts it.

## Files

All under `~/.pushwork`:

| Path | Holds |
| --- | --- |
| `run/daemon.sock` | The socket the daemon listens on. |
| `daemon.lock` | The lock the daemon holds for its whole life (see `src/lock.ts`). |
| `daemon.pid` | The daemon's pid, written once it listens and removed when it stops. |
| `daemon.busy` | The commands the daemon is running, as JSON: `{ pid, calls: [{ fn, cwd, since }] }`. Written aside and renamed in, synchronously, as each command starts and ends, so it is on disk before the command's work can keep the daemon from doing anything else. Removed when it stops. |
| `daemon.log` | The daemon's log, started afresh by each daemon that starts, which copies the last one's to `daemon.log.1` first. Clients append to it when they start one, so a daemon that fails to start leaves its error there. An exception that kills the daemon is logged with the time. |

Whoever can connect to the socket runs commands as the user, so `run/` is kept `0o700` and the socket `0o600`, and a directory that belongs to someone else is an error. A `run/` that is loose is tightened by the daemon that starts next; a client treats it as no daemon. If the socket's path is longer than 100 bytes, it is `/tmp/pushwork-<uid>/<hash>.sock` instead, with the same checks, where `<hash>` is the first 12 hex digits of the sha-256 of the home directory. On Windows it is the named pipe `\\.\pipe\pushwork-<hash>`.

## Lifecycle

The daemon takes `daemon.lock` before it listens, and only the holder listens. A daemon started while another is serving exits. One started while another is on its way out waits up to a minute for the lock. A holder that has had no socket for 8 seconds, less than a client waits for a daemon to start, is taken over, and only from the holder that was waited on; a daemon whose lock was taken over stops without touching the new one's socket.

It stops when:

- asked to (`daemon stop`, a client replacing it, `SIGTERM` or `SIGINT`);
- it has run no command for 10 minutes;
- its home's `.pushwork` is gone, which it checks every 30 seconds.

Stopping drains: the daemon keeps listening, so no new daemon opens the store under it, until the commands it is running finish, and connected clients that are not running one have hung up or 10 seconds have passed. Then it closes the socket and the hub, removes its pid file and exits.

## Finding the daemon

A client says hello with its version: the package version plus the mtime of `dist/daemon.js`, so rebuilding or upgrading pushwork makes the running daemon out of date.

| What the socket does | What the client does |
| --- | --- |
| Nothing listens, or `run/` is loose | Starts a daemon. |
| Answers, same version | Uses it. |
| Answers, different version, or stopping | Asks it to stop (it drains), waits for it to go (for as long as it is running a command, as below, and 10 seconds more), starts a new one. |
| Accepts but doesn't answer 3 hellos over about 6 seconds, and `daemon.busy` names the pid in `daemon.pid`, alive, running a command that started under 10 minutes ago | Waits, saying `waiting for the pushwork daemon (busy with <fn> in <cwd>)`, and says hello again. A command's Automerge work can keep the daemon from answering for a long time, and terminating it would kill that command. |
| Accepts but doesn't answer, and isn't busy as above | Sends the pid in `daemon.pid` `SIGTERM`, then `SIGKILL` after 2 seconds, and starts a new one. On Windows `SIGTERM` is already a kill. |

A command that has waited a second for the daemon, to start or to answer, says `waiting for the pushwork daemon…`. These notes go to stderr, but in an interactive terminal.

The new daemon is started detached, with the log as its output and the filesystem root as its working directory. If none answers within 10 seconds, the CLI warns, pointing at the log, and runs the command in its own process. `version` and `daemon ...` commands neither start a daemon nor stop one.

`daemon stop` and `--no-daemon` find the daemon the same way, then ask it to stop and wait for it to go: for as long as it is running a command (as above), and then a minute more before terminating it. A daemon that has exited is gone, even if a new one has taken the socket by then.

## RPC

The socket carries length-prefixed CBOR frames (`src/rpc.ts`), each a call, a result or an error, with a limit of 256 MiB per frame. Functions in the arguments, such as a progress reporter, cross as numbered references that the other side calls back. Maps and plain objects are marked so they survive the encoding.

The daemon answers four methods: `hello`, `status`, `stop` and `call`. A `call` names a command and carries its arguments and the caller's working directory. The commands are a fixed list (`COMMANDS` in `src/daemon.ts`: those `src/cli.ts` calls, and nothing else from `src/pushwork.ts`); any other name is an error. In the daemon `process.cwd()` answers with the caller's directory, per call, so relative paths mean what they mean to the user. The CLI gets the same functions either way, either the library's or stubs that call the daemon (`remote()` in `src/client.ts`).

Once the caller's connection has closed (Ctrl-C, say), its functions throw `the command was cancelled` when the command calls them. Commands report at every step, so a cancelled one stops at its next, before it publishes or writes anything more, and lets go of the checkout's lock.

The daemon's own output, `DEBUG` logging and whatever a custom shape or strategy prints included, goes to `daemon.log`.

## The hub

A Subduction node keeps the documents it has touched in memory and never rereads storage, so a second node writing the same store leaves the first sending stale state. For this reason the daemon opens one node on the machine store, a `Hub` (`src/hub.ts`), and every plain repo's commands open their documents through it, so its node is the only writer. The hub keeps one connection per server; callers that need the same server at once share one dial, and a connection the server dropped is dialled again. It is opened on the first command, so a store that can't be opened fails that command, not the daemon.

Keyhive repos keep their own node for each command, as they do without the daemon.

Outside the daemon, a process that opens the machine store (the library, `--no-daemon`, or the CLI when the daemon can't be started) stops a running daemon first, once per process, as `daemon stop` does, so the daemon's node isn't left with stale state. A daemon started after that, by a command in another terminal, runs beside it.

## Concurrency

Commands run concurrently, each with its own working directory. `migrate` writes the store directly, which the hub's node would never see, so it runs alone: it waits for the running commands to finish, holds new ones back, and when it is done the hub is closed and opened again.

Two commands in one checkout still fail on the checkout's lock, whether or not they go through the daemon. When the daemon holds it, the error says the daemon is running a command in that checkout.

## Limits

- One daemon per home directory.
- Servers are connected on first use and stay connected until the daemon stops; `daemon status` lists those currently connected.
- A command that was running when a daemon is terminated fails with "the pushwork daemon stopped while running this command".
