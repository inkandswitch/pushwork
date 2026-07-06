<!--
Thanks for the PR! A few notes to keep things smooth:

- Title: use imperative mood, no trailing period
  (e.g. "Add snarf paste command" — not "Added snarf...")
- One logical change per PR. Big refactors are easier to review when
  split into a series.
- For sync-protocol, document-shape, or config-format changes, link the
  relevant design doc in `design/` or call out where the discussion
  happened.
- Delete sections that don't apply.
-->

## Summary

<!--
What does this PR change, and why? Lead with the motivation — the
"what" is visible in the diff; the "why" is what reviewers need.
1–3 bullet points is ideal.
-->

-

## Related issues

<!--
Link issues this addresses. Use `Fixes #123` to auto-close on merge,
or `Refs #123` for related-but-not-closing.
-->

-

## Type of change

<!-- Check all that apply. -->

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (CLI, document shape, config format, or behavior)
- [ ] Performance improvement
- [ ] Refactor / cleanup (no behavior change)
- [ ] Documentation
- [ ] CI / build / tooling
- [ ] Dependency bump

## How was this tested?

<!--
Concrete steps: which tests / benches / manual runs. For sync or
delivery-path changes, note whether you clone-verified (init → clone →
byte-identical trees).
-->

-

## Breaking changes

<!--
If you checked "Breaking change" above, describe the break and the
migration path here. Config-format changes need a CONFIG_VERSION bump
and a migration in src/migrations.ts. Delete this section otherwise.
-->

## Checklist

- [ ] **I have personally reviewed every line of this diff.** I have read the code, understand what each change does, and am willing to defend it on its merits. AI-assisted authoring is welcome; unreviewed AI output is not.
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes (or relevant subset, with rationale)
- [ ] `pnpm typecheck` and `pnpm lint` are clean
- [ ] User-visible changes are reflected in `README.md` or the relevant `design/` doc
