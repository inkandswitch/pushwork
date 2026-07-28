# pushwork

Bidirectional directory synchronization using Automerge CRDTs. Single package,
pnpm, TypeScript.

## changesets

Every change that affects published behaviour ships with a changeset. Run:

```
pnpm changeset
```

Pick the bump (patch for fixes, minor for features, major for breaking changes)
and write a one-line summary in the imperative. The generated file in
`.changeset/` gets committed alongside the code.

Changes that don't affect the published package — tests, CI, docs, internal
refactors with no observable difference — don't need one. If CI complains and
the change really is invisible to users, `pnpm changeset --empty`.

Don't edit `version` in `package.json` or write `CHANGELOG.md` by hand. The
release workflow does both when the changesets land on `main`.

## checks

```
pnpm test
pnpm typecheck
pnpm lint
```
