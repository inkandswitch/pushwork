# Contributing to pushwork

Thanks for your interest in contributing! pushwork is early-stage software with an unstable API, so please open an issue to discuss substantial changes before investing significant effort.

## Getting Started

### Prerequisites

- Node.js `>= 24`
- [pnpm](https://pnpm.io/) `>= 8`
- Optionally, [Nix](https://nixos.org/) — `nix develop` provides a complete dev shell (Node, pnpm, TypeScript language servers, and a command menu)

### Setup

```sh
git clone git@github.com:inkandswitch/pushwork.git
cd pushwork
pnpm install
pnpm build        # required — workers run from dist/
```

### Development Loop

| Command           | Description                         |
| ----------------- | ----------------------------------- |
| `pnpm dev`        | `tsc --watch`                       |
| `pnpm test`       | Run the Vitest suite                |
| `pnpm test:watch` | Watch mode                          |
| `pnpm typecheck`  | `tsc --noEmit`                      |
| `pnpm lint`       | ESLint over `src`                   |
| `pnpm bench`      | Build and run the benchmark harness |

## Making Changes

- _One logical change per PR._ Big refactors are easier to review when split into a series.
- Use imperative mood for commit subjects, no trailing period (e.g. "Add snarf paste command", not "Added snarf paste command...").
- Explain _why_ before _how_ in commit messages and documentation.
- For sync-protocol, document-shape, or config-format changes, link the relevant document in [`design/`](./design/) or update it in the same PR.
- Config format changes must bump `CONFIG_VERSION` and ship a migration in `src/migrations.ts` (see [`design/config.md`](./design/config.md)).
- Changes that touch sync or delivery paths should be clone-verified: `init` a tree, `clone` it fresh, and confirm the trees are byte-identical.

## Testing

- Unit tests live in `test/unit/`, integration tests in `test/integration/`.
- Prefer property-based tests (via [`fast-check`](https://fast-check.dev/)) for functions with clear invariants: parsers, encoders, roundtrips.
- Don't add tests that only exercise language features or third-party libraries.

## Submitting a Pull Request

Before opening a PR, please make sure:

- [ ] You have personally reviewed every line of your diff. AI-assisted authoring is welcome; unreviewed AI output is not.
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes
- [ ] `pnpm typecheck` and `pnpm lint` are clean
- [ ] User-visible changes are reflected in `README.md` or the relevant `design/` doc

## License

By contributing, you agree that your contributions will be dual-licensed under the [MIT](./LICENSE-MIT) and [Apache 2.0](./LICENSE-APACHE) licenses, without any additional terms or conditions.
