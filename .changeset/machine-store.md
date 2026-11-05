---
"pushwork": major
---

Keep documents in one store per machine, `~/.pushwork/storage`, instead of in each repo

- Each checkout records the heads it last saw in `.pushwork/heads.json`, so two checkouts of one URL on a machine stay independent: one's `sync` doesn't show up in the other's `status`, and their edits merge on the next `sync`.
- Config is version 7. `pushwork migrate` upgrades a version 6 repo offline, keeping the old storage in `.pushwork/pushwork_migration_backup_safe_to_delete/storage-v6`.
- A sync server can only fetch or push documents that were synced with it.
- Two commands in one checkout no longer run at once; the second fails with the first one's pid.
