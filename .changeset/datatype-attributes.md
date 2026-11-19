---
"pushwork": patch
---

Map file endings to Patchwork datatypes with `datatype=<type>` rules in `.pushworkattributes`. A matching file holding a JSON object is stored as a JSON document of that type, with `import=<url>` setting `@patchwork.suggestedImportUrl` (and `frozenImportUrl` for a URL pinned to heads). Because the rules travel with the repo, every clone gets the same datatypes. `strip-metadata` on a rule keeps `@patchwork` out of the files on disk; pushwork rebuilds it from the rule and the document when reading them back, including during a clone. A disk copy that omits `@patchwork` no longer deletes it from a JSON document, in `sync`/`save` and in `yeet`. The new `Datatype` type is exported.
