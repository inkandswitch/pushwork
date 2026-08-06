# Security Policy

> [!CAUTION]
>
> pushwork is an early release preview with an unstable API. No guarantees are given. Do not use it for production or sensitive data at this time.

## Reporting a Vulnerability

Please do _not_ open a public issue for security vulnerabilities. Instead, report them privately via [GitHub Security Advisories](https://github.com/inkandswitch/pushwork/security/advisories/new).

We will acknowledge reports as promptly as we can and work with you on disclosure timing.

## Scope

pushwork synchronizes directory contents through a sync server. Keep in mind:

- File contents are _not_ end-to-end encrypted by pushwork itself; anyone with the `automerge:` root URL can clone the tree from the sync server. Treat root URLs as capabilities and share them accordingly.
- Deleted files are removed from the folder document but the underlying document history remains on the server (there is currently no garbage collection or history purge).
- Transport security depends on the sync server deployment (use `wss://`).
