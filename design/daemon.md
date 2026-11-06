# The daemon

Commands run in a background process, one per home directory, which keeps a connection open to each sync server between commands. A command that would otherwise dial the server, sync, and hang up instead asks the daemon, which is usually already connected.

`pushwork --no-daemon <command>` runs the command in its own process, and stops the daemon if one is running. `pushwork daemon status` shows the daemon's pid, version, start time, connected servers, socket and log. `pushwork daemon stop` asks it to stop once the commands it is running finish; the next command starts it again. The hidden `pushwork daemon run` is what starts it.

## Files

All under `~/.pushwork`:

| Path | Holds |
| --- | --- |
| `run/daemon.sock` | The socket the daemon listens on. |
| `daemon.lock` | The lock the daemon holds for its whole life (see `src/lock.ts`). |
| `daemon.pid` | The daemon's pid, written once it listens and removed when it stops. |
| `daemon.log` | The daemon's log, emptied by each daemon that starts. Clients append to it when they start one, so a daemon that fails to start leaves its error there. |

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
| Answers, different version, or stopping | Asks it to stop (it drains), waits for the socket to go, starts a new one. |
| Accepts but doesn't answer 3 hellos over about 6 seconds | Sends the pid in `daemon.pid` `SIGTERM`, then `SIGKILL` after 2 seconds, and starts a new one. A busy daemon is slow to answer, not hung, so a single missed hello is not enough. |

The new daemon is started detached, with the log as its output and the filesystem root as its working directory. If none answers within 10 seconds, the CLI warns, pointing at the log, and runs the command in its own process. `version` and `daemon ...` commands neither start a daemon nor stop one.

## RPC

The socket carries length-prefixed CBOR frames (`src/rpc.ts`), each a call, a result or an error, with a limit of 256 MiB per frame. Functions in the arguments, such as a progress reporter, cross as numbered references that the other side calls back. Maps and plain objects are marked so they survive the encoding.

The daemon answers four methods: `hello`, `status`, `stop` and `call`. A `call` names a command and carries its arguments and the caller's working directory. The commands are a fixed list (`COMMANDS` in `src/daemon.ts`: those `src/cli.ts` calls, and nothing else from `src/pushwork.ts`); any other name is an error. In the daemon `process.cwd()` answers with the caller's directory, per call, so relative paths mean what they mean to the user. The CLI gets the same functions either way, either the library's or stubs that call the daemon (`remote()` in `src/client.ts`).

## The hub

A Subduction node keeps the documents it has touched in memory and never rereads storage, so a second node writing the same store leaves the first sending stale state. For this reason the daemon opens one node on the machine store, a `Hub` (`src/hub.ts`), and every plain repo's commands open their documents through it, so its node is the only writer. The hub keeps one connection per server; callers that need the same server at once share one dial, and a connection the server dropped is dialled again. It is opened on the first command, so a store that can't be opened fails that command, not the daemon.

Keyhive repos keep their own node for each command, as they do without the daemon.

## Concurrency

Commands run concurrently, each with its own working directory. `migrate` writes the store directly, which the hub's node would never see, so it runs alone: it waits for the running commands to finish, holds new ones back, and when it is done the hub is closed and opened again.

Two commands in one checkout still fail on the checkout's lock, whether or not they go through the daemon.

## Limits

- One daemon per home directory.
- Servers are connected on first use and stay connected until the daemon stops; `daemon status` lists those currently connected.
- A command that was running when a daemon is terminated fails with "the pushwork daemon stopped while running this command".
