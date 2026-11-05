# Machine-wide store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every pushwork document into one store at `~/.pushwork/storage`, give each checkout its own record of the heads it last saw, and keep each sync server to the documents synced with it.

**Architecture:** `FsStorage` stays as is but lives in the home directory and tracks `sent` per server. `Docs` gains a per-document *base* (from `.pushwork/heads.json`): reads view the base, writes go through `A.changeAt` at the base, and `advance()` moves to live after a sync. Each `Docs` node runs a deny-by-default Subduction `Policy` that lets a peer touch only documents this run started syncing with it. Config goes to version 7; `pushwork migrate` upgrades v6 offline.

**Tech Stack:** TypeScript (Node ≥ 24), `@automerge/automerge` 3.3.2, `@automerge/automerge-subduction` 0.16.1, vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-machine-store-design.html` (published at https://claude.ai/artifact/JxJC5FEtpAeL5m47S3omSk). Read it before starting.

## Global Constraints

- Store path: `path.join(os.homedir(), ".pushwork", "storage")`. Tests isolate it through `HOME` (`test/home.ts`, `test/global-setup.ts`); never hard-code a path.
- `.pushwork/storage` is no longer written by any command. It is only read by `migrate`.
- `yoink`, `yeet`, `shape install`, `keyhive check`, `Docs.pull()` and `fetchCard` keep their `MemoryStorage`; they must not touch the machine store.
- No new dependencies.
- No `.pushwork` path appears in `heads.json`; it holds document ids and hex heads only.
- Code style: tabs, existing comment voice (short, lowercase-ish, explains why). Relative imports in `src/pushwork.ts` use the `.js` suffix like their neighbours.
- Commit messages: plain imperative sentence like the existing history ("Add `keyhive contacts`"). **No `Co-Authored-By` trailer** (user preference).
- `pnpm lint` cannot run: ESLint isn't installed (`sh: eslint: command not found`). The spec's ESLint rule is implemented as a unit test instead (Task 2). Checks are `pnpm test` and `pnpm typecheck`.

## Review Focus

1. **Large trees with one checkout.** Base equals live for nearly everyone; `find` must not pay for `A.view` then. Expect `find` to return the live doc object itself when base equals live heads. Test in Task 3.
2. **A v7 checkout with no `heads.json`** (deleted by hand). Expect it to behave as today: everything reads live, `status` works, the next `save`/`sync` writes the file. Test in Task 4.
3. **A hand-edited, corrupt `heads.json`.** Expect an error naming the file, not a JSON stack trace. Test in Task 4.
4. **Two checkouts of one URL syncing at the same moment** (different checkout locks, one shared store). Expect both to succeed and, after one more sync each, to hold identical bytes. Test in Task 4.
5. **Rerunning `migrate` after a failed one.** Expect the second run to succeed once the cause is fixed, with copies left by the first run harmless. Test in Task 5.

---

### Task 1: Store layout — per-server `sent`, vanished blobs, importing a repo store

**Files:**
- Modify: `src/storage.ts` (`sentFile`, `loadSent`, `saveSent`, `read`, `loadAllFragments`, `deleteSedimentreeId`; new `importStore`)
- Test: `test/unit/storage.test.ts`

**Interfaces:**
- Produces:
  - `FsStorage.loadSent(id: SedimentreeId, server: string): Promise<string[]>` and `saveSent(id, server, heads)`: unchanged signatures; files at `sent/<serverKey>/<hex id>` where `serverKey = hex(blake3(utf8(server))).slice(0, 16)`. File body stays `server\nhead\nhead…\n`.
  - `importStore(fromRoot: string, to: FsStorage): Promise<{ docs: number }>` exported from `src/storage.ts`: copies every sedimentree under `fromRoot/trees` into `to` with `saveBatchAll` (skipping nothing explicitly: `writePair` already no-ops on an identical pair), and converts each legacy flat file `fromRoot/sent/<hex id>` (first line the server) with `to.saveSent`.

- [ ] **Step 1: Write the failing tests**

Replace `"remembers the fragment heads a server holds, for that server only"` with:

```ts
it("remembers the fragment heads each server holds, separately", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-sent-"));
	const storage = await FsStorage.open(dir);
	const a = ["00" + "a".repeat(62)];
	const b = ["00" + "b".repeat(62)];
	await storage.saveSent(sid(), "ws://a", a);
	await storage.saveSent(sid(), "ws://b", b);
	const again = await FsStorage.open(dir);
	expect(await again.loadSent(sid(), "ws://a")).toEqual(a);
	expect(await again.loadSent(sid(), "ws://b")).toEqual(b);
	expect(await again.loadSent(sid(), "ws://c")).toEqual([]);
	await again.deleteSedimentreeId(sid());
	expect(await again.loadSent(sid(), "ws://a")).toEqual([]);
	await fs.rm(dir, { recursive: true, force: true });
});
```

Add:
- `"treats a blob deleted between listing and reading as absent"`: store one commit, then `vi.mock("fs/promises", …)` (partial, via `importOriginal`) so the first `readFile` of a path ending `.blob` rejects with `Object.assign(new Error("gone"), { code: "ENOENT" })`; `loadAllCommits(sid())` resolves to `[]` instead of throwing. Put it in its own `describe` so the mock doesn't leak.
- `"lists fragments again when one vanishes mid-read"`: same mock, but for a fragment path, with two fragments stored; `loadAllFragments(sid())` resolves to both fragments (the retry sees them, since the mock only fails once).
- `"imports a repo store, converting its sent records"`: build a store in `dirA` (one commit via `saveCommit`), write a legacy file `dirA/sent/<hex sid>` containing `"ws://x\n" + "00" + "c".repeat(62) + "\n"`; `importStore(dirA, storeB)` returns `{ docs: 1 }`; `storeB.loadAllCommits(sid())` has length 1; `storeB.loadSent(sid(), "ws://x")` equals `["00" + "c".repeat(62)]`; a second `importStore` call succeeds and changes nothing.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/unit/storage.test.ts`
Expected: the four new/changed tests FAIL (`ws://a` heads lost after `ws://b`; ENOENT thrown; `importStore` not exported).

- [ ] **Step 3: Implement**

- `sentFile(id, server)` → `path.join(this.root, "sent", serverKey(server), hex(id.toBytes()))`. `deleteSedimentreeId` removes `sent/*/<hex id>` for every server directory present.
- `read` returns `null` when either `readFile` rejects with `ENOENT`.
- `loadAllFragments`: if any listed fragment came back `null` because its file vanished, list and read the directory once more and return that result. (A fragment only disappears when compaction has already written the one replacing it.)
- `importStore` as in Interfaces. Copy each sedimentree's commits and fragments the way `Docs.pull` builds its `saveBatchAll` arguments (`src/docs.ts:483-487`). Skip files under `sent/` that are directories (already per-server).

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm vitest run test/unit/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts test/unit/storage.test.ts
git commit -m "Track sent heads per server and tolerate blobs compacted mid-read"
```

---

### Task 2: Server isolation — a deny-by-default policy

**Files:**
- Create: `src/allowlist.ts`
- Modify: `src/docs.ts` (`Docs.open`, constructor, `syncDoc`)
- Modify: `test/server.ts` (`startServer` also returns `node`)
- Test: `test/unit/allowlist.test.ts`, `test/unit/no-broadcast.test.ts`

**Interfaces:**
- Produces:
  - `class Allowlist` in `src/allowlist.ts`:
    - `allow(peer: PeerId, id: SedimentreeId): void`
    - `has(peer: PeerId, id: SedimentreeId): boolean`, keyed on `hex(peer.toBytes()) + "/" + hex(id.toBytes())`
    - `policy(): Policy`: `authorizeConnect` resolves; `authorizeFetch(peer, id)` and `authorizePut(requestor, _author, id)` reject with `Error("not synced with this peer")` unless `has(peer|requestor, id)`; `filterAuthorizedFetch(peer, ids)` returns the allowed subset.
    - `ephemeralPolicy(): EphemeralPolicy`: subscribe and publish reject; `filterAuthorizedSubscribers` returns `[]`.
  - `startServer(policy?)` resolves to `{ url, node, stall, close }`, where `node` is the server's `Subduction`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing tests**

`test/unit/allowlist.test.ts`, using `open()` from the docs tests' pattern (`MemoryStorage`, `MemorySigner.generate()`):

```ts
it("still syncs documents with the server it started syncing them with", async () => {
	const server = await startServer();
	const docs = await open({ server: server.url });
	const url = await docs.create({ n: 1 });
	expect(await docs.sync()).toMatchObject({ online: true, synced: 1, unsynced: [] });
	await docs.close(); await server.close();
});

it("doesn't let another connected server fetch a document", async () => {
	const x = await startServer();
	const y = await startServer();
	const docs = await open({ server: x.url });
	await docs.connect(y.url);
	const url = await docs.create({ secret: true });
	await docs.sync();
	const id = toSedimentreeId(parseAutomergeUrl(url).documentId);
	const [client] = await y.node.getConnectedPeerIds();
	await y.node.syncWithPeer(client, id, false, 5_000);
	expect(await y.node.getBlobs(id)).toHaveLength(0); // or the equivalent read of y's storage
	// …close all
});

it("refuses a document a server pushes without being asked", async () => {
	// y.node stores a commit for a fresh sedimentree id, then syncWithPeer(client, thatId);
	// the client's MemoryStorage has no commits for thatId afterwards
});
```

Use whatever read of the server node's storage the 0.16.1 API offers (`getBlobs`, or the `MemoryStorage` passed in, which `startServer` can also return). The assertion is "Y holds nothing for that id".

`test/unit/no-broadcast.test.ts`: read every `src/**/*.ts` file and assert that none matches
`/\.(syncWithAllPeers|fullSyncWithPeer|fullSyncWithAllPeers|addBatch|addCommit|addCommitsBatch|addFragment|addFragmentsBatch|addSedimentree)\(/`, with the failing file names in the message. Add a one-line comment saying why: these talk to every connected peer.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/unit/allowlist.test.ts test/unit/no-broadcast.test.ts`
Expected: the two isolation tests FAIL (Y receives the doc; the stray doc lands); the sync and no-broadcast tests already PASS.

- [ ] **Step 3: Implement**

- `Docs.open` creates an `Allowlist`, passes `policy: allowlist.policy(), ephemeralPolicy: allowlist.ephemeralPolicy()` to `new Subduction`, and hands it to the constructor.
- `syncDoc` calls `this.allowlist.allow(this.peer!, sid)` before its first `syncWithPeer`.
- `Docs.pull`'s throwaway `MemoryStorage` node is left without a policy.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm test`
Expected: PASS, including `test/unit/keyhive.test.ts`, `test/unit/keyline.test.ts` and `test/integration/keyline-cli.test.ts`. If a keyhive test fails with "not synced with this peer", keyhive is syncing a document through the node outside `syncDoc`. Find that path and add the document to the allowlist there. Don't add a blanket exception.

- [ ] **Step 5: Commit**

```bash
git add src/allowlist.ts src/docs.ts test/server.ts test/unit/allowlist.test.ts test/unit/no-broadcast.test.ts
git commit -m "Only exchange a document with the server a sync of it was started with"
```

---

### Task 3: Per-document base in `Docs`

**Files:**
- Modify: `src/docs.ts` (`DocsOptions`, `Entry`, `find`, `change`, `pin`, `load`, `blobs`; new `advance`, `checkoutHeads`, `MissingBase`)
- Test: `test/unit/docs.test.ts` (new `describe("Docs base", …)`)

**Interfaces:**
- Produces:
  - `DocsOptions.base?: Map<DocumentId, string[]>`: hex Automerge heads per document, as `A.getHeads` returns them.
  - `Docs.advance(): void`: every loaded entry's base becomes its live heads, and documents loaded later ignore `options.base`.
  - `Docs.checkoutHeads(): Map<DocumentId, string[]>`: for every loaded entry, its base, or its live heads when it has none.
  - `class MissingBase extends Error` (exported), `name = "MissingBase"`, message: `` `this checkout's saved state for ${url} is missing from ~/.pushwork/storage; \`pushwork sync\` fetches it if the server has it` ``.
- Consumes: `Allowlist` from Task 2 (unchanged by this task).

- [ ] **Step 1: Write the failing tests**

Each test makes a doc with an `FsStorage` in a temp dir, changes it, records heads `h1`, changes it again (`h2`), closes, and reopens with `open({ storage, base: new Map([[id, h1]]) })`:

- `"find shows the document at its base"`: `find(url)` has the first change's value; `heads(url)` equals `h1`.
- `"change writes at the base and moves it"`: `change(url, d => { d.b = 1 })`; `heads(url)` is one new head whose deps are `h1` (check with `A.inspectChange` on the live doc after `advance()`); after `advance()`, `find(url)` has both the second change's value and `b`.
- `"advance moves every base to live"`: after `advance()`, `heads(url)` equals the live heads (two heads: `h2`'s change and the new one).
- `"a document missing from the map reads live"`: open with an empty map; `find(url)` shows `h2`'s value.
- `"find returns the live document itself when base is live"`: base `h2`; `(await docs.find(url)) === (await docs.find(url))`, and it isn't an `A.view` (compare with a second `open` that has no base: same values, and `A.getHeads` of the result equals the live heads).
- `"a missing base head fails offline"`: base `["ab".repeat(32)]`; `find(url)` rejects with `MissingBase`.
- `"pin uses the base"`: `pin(url)` parses to heads `h1`.
- `"checkoutHeads reports base, or live heads without one"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/unit/docs.test.ts -t "Docs base"`
Expected: FAIL (`base` ignored, `advance` not a function).

- [ ] **Step 3: Implement**

- `Entry` gains `base?: string[]`. `load()` sets it from `options.base` unless `advance()` has run. If the base isn't in the doc (`!A.hasHeads(doc, base)`): when online, `syncDoc` and reread once; still missing, throw `MissingBase`.
- `find` without URL heads: no base, or base equal to `A.getHeads(entry.doc)` as a set → return `entry.doc`; otherwise `A.view(entry.doc, base)`.
- `change`: with a base, use `A.changeAt(entry.doc, base, fn)`; take `newDoc`, and when `newHeads` is non-null set `base = newHeads` and mark dirty. Without a base, keep today's `A.change`.
- `pin` uses `entry.base ?? A.getHeads(entry.doc)`.
- `touch` stays at live and doesn't move the base.
- `blobs()`: load commits, *then* fragments (sequentially, not `Promise.all`). A commit only vanishes once compaction has stored the fragment covering it, so reading fragments second always finds it.

- [ ] **Step 4: Run the docs tests**

Run: `pnpm vitest run test/unit/docs.test.ts`
Expected: PASS (new and existing).

- [ ] **Step 5: Commit**

```bash
git add src/docs.ts test/unit/docs.test.ts
git commit -m "Read and write each document at a checkout's base heads"
```

---

### Task 4: Checkouts on the machine store

**Files:**
- Create: `src/lock.ts` (move `lock()` and `alive()` from `src/keyhive/common.ts:146-179` unchanged; `common.ts` imports it)
- Create: `src/checkout.ts`
- Modify: `src/config.ts` (`CONFIG_VERSION = 7`, `storeDir()`, rename `storageDir` → `legacyStorageDir`, version error messages)
- Modify: `src/pushwork.ts` (`openDocs`, `openRepo`, `loadSavedTree`, `commitWorkdir`, `init`, `attach`, `sync` nuclear path, `nuclearizeRepo`, `cutWorkdir`, `pasteSnarf`, `openKeyhiveRepo`)
- Test: `test/unit/checkout.test.ts`, `test/integration/checkouts.test.ts`

**Interfaces:**
- Consumes: `DocsOptions.base`, `Docs.advance()`, `Docs.checkoutHeads()`, `MissingBase` (Task 3).
- Produces:
  - `src/checkout.ts`:
    - `readHeads(root: string): Promise<Map<DocumentId, string[]>>`: reads `.pushwork/heads.json`; a missing file gives an empty map; invalid JSON or wrong shape throws `` `${file} is corrupt (${reason}); delete it and run \`pushwork sync\`` ``.
    - `writeHeads(root: string, heads: Map<DocumentId, string[]>): Promise<void>`: writes `{"version":1,"heads":{"<documentId>":["<hex>",…]}}` to a temporary file in `.pushwork/`, then renames it into place.
    - `lockCheckout(root: string): Promise<() => Promise<void>>` = `lock(path.join(pushworkDir(root), "checkout"))`, so the file is `.pushwork/checkout.lock`.
  - `storeDir(): string` in `src/config.ts` = `path.join(os.homedir(), ".pushwork", "storage")`.
  - `openRepo(cwd, { online?, reader?, lock? })` returns `{ root, config, docs, hive, group, close }`, where `close()` closes `docs`, then `hive`, then releases the lock. `lock` defaults to `true`; `status`, `diff` and `heads` pass `lock: false`. Every caller uses `close()` in its `finally`.

- [ ] **Step 1: Write the failing tests**

`test/unit/checkout.test.ts`:
- `writeHeads` then `readHeads` round-trips a two-entry map.
- `readHeads` on a dir with no `heads.json` → empty map.
- `readHeads` on `heads.json` containing `{"version":1,"heads":` → rejects matching `/heads\.json is corrupt/`.

`test/integration/checkouts.test.ts` (CLI via `test/cli.ts`, server via `inject("server")`, two clones `a` and `b` of one URL; the suite shares the global test `HOME`, so both use one store):
- `"a sync in one checkout leaves the other's status clean"`: `a` edits `notes.txt` line 1 and syncs; `pushwork --porcelain status` in `b` prints nothing.
- `"edits to one file from two checkouts both survive"`: `notes.txt` is three lines. `a` edits line 1 and syncs; `b` edits line 3 and syncs; `b`'s file has both edits; `a` syncs; `a` and `b` have identical bytes.
- `"save doesn't pull in another checkout's changes"`: `b` edits line 3 and saves; `a` edits line 1 and syncs; `b`'s `status` is clean and `b`'s line 1 is unchanged; `b` syncs and has both edits.
- `"two checkouts can sync at the same moment"`: both edit different lines, run `sync` together with `Promise.all`, then each syncs once more; identical bytes.
- `"works without heads.json"`: delete `b/.pushwork/heads.json`; `status` is clean; `sync` succeeds and recreates it.
- `"a running command in the same checkout blocks another"`: write `b/.pushwork/checkout.lock` containing `String(process.pid)`; `pushwork sync` in `b` rejects matching `/in use by pushwork pid/`; `status` still works.
- `"a lock left by a dead process is taken over"`: lock file containing `"999999"` (check `process.kill(999999, 0)` throws first, else pick another); `sync` succeeds.
- `"no .pushwork/storage is written"`: after `init`, `clone` and `sync`, `exists(path.join(dir, ".pushwork", "storage"))` is false.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/unit/checkout.test.ts test/integration/checkouts.test.ts`
Expected: FAIL (`src/checkout.ts` missing; `b`'s status shows `a`'s edit as modified).

- [ ] **Step 3: Implement**

- `openDocs(root, seed, server, hive, group, base?)` opens `FsStorage.open(storeDir())` and passes `base`.
- `openRepo` locks (unless `lock: false`), then `readHeads(root)` for `base`, and passes it. If opening fails after locking, release the lock before rethrowing.
- `commitWorkdir`: online path calls `docs.advance()` right after `syncAll`, *before* `refreshPins`, so pins and the written tree are both live as they are today. Offline (`save`) doesn't advance. Both paths `writeHeads(root, docs.checkoutHeads())` after `materialize`.
- `init`, `attach` (clone/track/merge): `writeHeads` after the tree has been read (`init` after `writeUrlAttrs(readSaved…)`, `attach` after `readSaved`). `attach` takes the checkout lock right after creating `.pushwork/`; `merge` releases it before calling `commitWorkdir`.
- `sync --nuclear` and `nuclearizeRepo`: `writeHeads` after `nuclearize` (no advance, as today nothing is written to disk).
- `cutWorkdir` and `pasteSnarf` lock; `heads`, `status`, `diff` don't. `loadSavedTree` takes and forwards the `lock` option.
- `readConfig`: version 6 → `` `pushwork config version 6 is from an older pushwork 3 — run \`pushwork migrate\`` ``; any other non-7 version keeps the "from pushwork 2" message.
- Existing tests that assert `CONFIG_VERSION` keep working through the import.

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. The old migrate test in `test/integration/pushwork.test.ts` (a v5 repo) still passes, because pre-v6 repos still go through `attach("track")`.

- [ ] **Step 5: Commit**

```bash
git add src/lock.ts src/checkout.ts src/config.ts src/pushwork.ts src/keyhive/common.ts test/unit/checkout.test.ts test/integration/checkouts.test.ts
git commit -m "Keep documents in one store per machine, with heads per checkout"
```

---

### Task 5: `pushwork migrate` from v6

**Files:**
- Modify: `src/config.ts` (`readOldConfig` reports the version; new `readConfigV6`)
- Modify: `src/pushwork.ts` (`migrate`; new `migrateStore`)
- Modify: `src/cli.ts:286-304` (the migrate action's task label)
- Test: `test/integration/migrate.test.ts`

**Interfaces:**
- Consumes: `importStore` (Task 1), `lockCheckout`, `writeHeads`, `storeDir`, `legacyStorageDir` (Task 4), `openDocs` (Task 4).
- Produces:
  - `readOldConfig(root)` returns `Migratable & { version?: number }`, or `undefined` when the version is 7.
  - `migrate(cwd, opts, report)` keeps its signature. For version 6 it runs `migrateStore(root, config)` offline and returns a `RepoSummary` whose `sync` report is offline (`{ online: false, synced: 0, unsynced: [] }`).

- [ ] **Step 1: Write the failing tests**

Build the v6 fixture in a separate home so the shared test store doesn't leak into it: `const h1 = tmp home`, `pushwork(["init", "--offline"], repo, homeEnv(h1))`, then move `h1/.pushwork/storage` to `repo/.pushwork/storage`, delete `repo/.pushwork/heads.json`, and rewrite `config.json` with `version: 6` and `syncServer: "ws://127.0.0.1:1"` (nothing listens there). Run every later command with `homeEnv(h2)`, a second fresh home.

- `"migrates a v6 checkout offline"`: `status` rejects with `/pushwork migrate/`; `migrate` succeeds even though the config's server is unreachable (proves nothing is fetched); `status` is clean; `heads.json` exists; `h2/.pushwork/storage/trees` is non-empty; `repo/.pushwork/pushwork_migration_backup_safe_to_delete/storage` exists; `repo/.pushwork/storage` doesn't; `config.json` has `version: 7`; `url` prints the same URL as before.
- `"a failed migration leaves a working v6 repo, and a rerun succeeds"` (`it.skipIf(process.platform === "win32")`): create `h2/.pushwork/storage` and `chmod 0o500` it; `migrate` rejects; `config.json` still has `version: 6`, `repo/.pushwork/storage` is intact, `heads.json` and `checkout.lock` don't exist; `chmod 0o700`, rerun `migrate`: succeeds, `status` clean.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/integration/migrate.test.ts`
Expected: FAIL (`migrate` takes the v5 path and tries to fetch).

- [ ] **Step 3: Implement `migrateStore(root: string, config: PushworkConfig): Promise<RepoSummary>`**

In order, under `lockCheckout(root)`, released in `finally`:
1. `importStore(legacyStorageDir(root), await FsStorage.open(storeDir()))`.
2. Open docs offline on the machine store with no base (open the keyhive archive as `openRepo` does for a keyhive root, as a reader), `readSaved` the tree, `writeHeads(root, docs.checkoutHeads())`, close.
3. Rename `legacyStorageDir(root)` to `.pushwork/${MIGRATION_BACKUP}/storage`.
4. `writeConfig(root, { ...config, version: CONFIG_VERSION })`.

On failure: remove `heads.json`; if step 3 ran, rename the storage back; rethrow. `readConfigV6(root)` parses a v6 file with the same field checks as `readConfig`, returning it as a `PushworkConfig` (version aside).

In `src/cli.ts`, the migrate action's `out.task("Connecting to sync server")` becomes `out.task("Migrating")`.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/pushwork.ts src/cli.ts test/integration/migrate.test.ts
git commit -m "Migrate v6 checkouts into the machine store offline"
```

---

### Task 6: Design docs and changeset

**Files:**
- Modify: `design/sync.md` (intro paragraph, "Storage and compaction"; mention checkout heads, the allowlist policy and the read ordering)
- Modify: `design/config.md` (format version 7; `.pushwork/heads.json` and `.pushwork/checkout.lock`; v6 → v7 migration in "Older versions")
- Modify: `design/README.md` (layer diagram: `Subduction<br/>(FsStorage in ~/.pushwork · one server connection)`, plus a line on checkout heads in Core Model)
- Create: `.changeset/machine-store.md`

- [ ] **Step 1: Update the three design docs** to match the code as built. Describe what is, in the docs' existing voice; no "will".

- [ ] **Step 2: Write the changeset**

```md
---
"pushwork": major
---

Keep documents in one store per machine, `~/.pushwork/storage`, instead of in each repo

- Each checkout records the heads it last saw in `.pushwork/heads.json`, so two checkouts of one URL on a machine stay independent: one's `sync` doesn't show up in the other's `status`, and their edits merge on the next `sync`.
- Config is version 7. `pushwork migrate` upgrades a version 6 repo offline, keeping the old storage in `.pushwork/pushwork_migration_backup_safe_to_delete/`.
- A sync server can only fetch or push documents that were synced with it.
- Two commands in one checkout no longer run at once; the second fails with the first one's pid.
```

(`major` per the spec. An unreleased major is already pending in `.changeset/subduction-direct.md`, so this ships in the same 3.0 either way.)

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add design/sync.md design/config.md design/README.md .changeset/machine-store.md
git commit -m "Document the machine store and checkout heads"
```
