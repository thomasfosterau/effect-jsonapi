# Contributing

## Workflow

- Branch off `trunk` and open pull requests into `trunk`. Don't commit to `trunk` directly.
- Open a draft PR as soon as you start, so others can see the work. Keep one PR per change, even a large one; related issues can share a PR.
- Out-of-scope work you notice goes in a new issue, not the current PR. Keep issue bodies evergreen: context, problem and proposed fix in the body, not appended as comments.
- Dependabot updates dependencies. Update one by hand only when your change needs it, or for the steps Dependabot cannot do (below).
- Getting your PR green, reviewed and free of conflicts is your responsibility. Rebase onto `origin/trunk`; don't merge `trunk` in.

## Toolchain

[Vite+](https://viteplus.dev) (`vp`) manages Node.js, pnpm and the tools; run everything through it (`vp exec <bin>`, not `npx`). `vp install` installs dependencies and the git hooks; the pre-commit hook formats and lints staged files.

| Command | Does |
| --- | --- |
| `vp check` | Format and lint (Oxfmt, Oxlint with the Effect presets, type-aware) |
| `vp run check` | The type gates: sources and type-level tests, the emitted declarations, the examples |
| `vp run -r test:unit` | The root and example test suites |
| `vp run build` | `dist/` |
| `vp run docgen` | Compiles and runs every JSDoc `@example` against `dist/`; writes `docs/api/` |
| `vp run ci` | All of the above plus `pnpm audit` and `typecheck:floor` (network), as CI runs it |
| `vp run test:coverage` | The coverage map `fallow audit` reads |

[Fallow](https://fallow.tools) checks dead code, duplication and complexity: `vp run test:coverage && vp exec fallow audit --base origin/trunk`. Use it to polish your work; its findings are guidance, not dogma, and CI doesn't run it.

`vp check` (format and lint) and `vp run check` (type gates) are different commands.

### Dependency updates by hand

Versions live only in the `pnpm-workspace.yaml` catalog; never edit one in a `package.json`. After changing the catalog, run `vp install` and commit `pnpm-lock.yaml`.

On a Dependabot toolchain PR, also move: the `vite` alias (equal to `vite-plus`), the `typescript` / `@typescript/native` aliases (to a pairing `@effect/tsgo` supports), and the devcontainer image tag (equal to `vite-plus`). Raise or drop the advisory floors under `overrides` when `pnpm audit` or their dependents change.

## Coding guidelines

### Effect

Use Effect idioms throughout, and strongly prefer Effect v4's own modules (`Option`, `Array`, `Match`, `Schema`, `Result`, …) over re-inventing them. Convert existing code where practical. The exceptions are non-Effect APIs adapted at the edge and hot paths where measured performance needs plain code. Read the installed `effect` package (`node_modules/effect/dist/*.d.ts`, its `src/`, `AGENTS.md` and `ai-docs/`) rather than guessing an API.

- HTTP modules are `effect/http` and `effect/http-api`.
- Import Effect modules as namespaces (`import * as Option from "effect/Option"`); never bind effect's `Record` as `Record` (use `R`).
- Absence is `Option`. `exactOptionalPropertyTypes` is on: an options member is `readonly x?: T`, with no `| undefined`. JSON:API wire shapes keep their native optionals and `null`, spelled from their schemas.
- Relative imports carry `.js`.
- Fix lint findings in code; a rule is relaxed only in `vite.config.ts`, with its reason.

[architecture.md](architecture.md) explains how the modules derive from one resource definition.

### Comments

- A file-level comment is optional: under 50 words, only for context the code can't give.
- Doc comments on exports add to what IntelliSense shows: what to reach for and when, not a restated signature. Public exports keep `@since`, a `@category` and, for principal APIs, an `@example`.
- Inline comments only where the code isn't self-explanatory: workarounds, performance, non-obvious decisions.
- No references to issues, PRs or CI runs, and no history ("this used to…"). Stable links to external docs are fine.

`vp run docgen` compiles **and runs** every `@example` (and every `ts` fence in a doc comment), importing the package by name through `dist/`. An example is a complete program that imports everything it uses, never uses `declare const`, imports assertions by name (`import { strictEqual } from "node:assert"`) and doesn't throw. Fence a non-runnable sketch as `ts skip-type-checking`.

### Tests

- Test logic and edge cases that would regress; don't test what the type system enforces or trivial behaviour.
- Import from `vite-plus/test`. Effect tests take `it` from `@effect/vitest` (`it.effect`, `it.live` for real time); never `Effect.runPromise` in a test body.
- Compile-time assertions go in `test/*.types.ts`, with `@ts-expect-error` above a statement that must fail. `test/emitted/*.types.ts` check the built declarations.
- Never lower a coverage threshold; add the test.

## Before pushing

Run `vp run ci` (or each gate in its order), then the Fallow audit above.

## Changesets

Every change to the published package's behaviour, including doc comments that reach the emitted `.d.ts`, needs a changeset: `vp run changeset`. Docs-, CI- and tooling-only changes need none. Pre-1.0, a breaking change is `minor`; never `major`. Never version or publish by hand: see [PUBLISHING.md](PUBLISHING.md).
