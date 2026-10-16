# Contributing to effect-jsonapi

Setup, commands and checklists for `@thomasfosterau/effect-jsonapi`; conventions are in [AGENTS.md](AGENTS.md).

## Development setup

### Prerequisites

- Node.js 22 or higher (`engines.node`)
- [pnpm](https://pnpm.io) 11 — the repo pins a version via the `packageManager` field, so `corepack enable` provisions the right one

### Getting started

1. Fork and clone the repository.
2. Install:

   ```bash
   pnpm install --frozen-lockfile
   ```

   This also installs the Vite+ git hooks (`vp config`) and, through the root `prepare` script, swaps the native `tsc` and `oxlint` binaries for their Effect-patched builds (`effect-tsgo patch --typescript --oxlint`). Every gate below runs on those.

3. Run the gates listed in [AGENTS.md → Verification](AGENTS.md#verification), in that order.

Agent sessions and the devcontainer are provisioned by the SessionStart hook; see [AGENTS.md → Agent sessions](AGENTS.md#agent-sessions).

## Development workflow

Every command on its own; the ordered pre-push run is [AGENTS.md → Verification](AGENTS.md#verification).

| Command | Description |
| --- | --- |
| `vp check` | Format check + lint (oxfmt + oxlint, configured in `vite.config.ts`). `vp check --fix` applies both. Distinct from `vp run check`. |
| `vp fmt` / `vp lint` | Either half on its own. |
| `vp run check` | The type gate: sources, colocated tests and `test/*.types.ts` (`typecheck`), the emitted declarations (`typecheck:dist`, which builds `dist/` first), and every example. |
| `vp run typecheck` | One of the above on its own; `vp run --filter ./examples/blog check` for one example. |
| `vp run -r test:unit` | Every suite — the root's and each example's — under `vite-plus/test`. `vp test` from a package directory for watch mode; `vp test run src/Resource.test.ts` for one file. |
| `vp run build` | `vp pack` (tsdown): one ESM entry per `package.json` export (the root, `./schema` and every module subpath) with shared code split into chunks, then `tsc -p tsconfig.build.json`: one declaration file per source module, into `dist/`. |
| `vp run docgen` | Type-check & run every JSDoc `@example`; generate API docs under `docs/`. |
| `pnpm changeset` | Add a changeset (see below). |
| `vp run fallow:audit` | Change-set review (dead code, complexity, duplication). The agent hooks run it before every commit; it is not a CI gate. |

`vp` resolves from `node_modules/.bin` after install; `vp exec <bin>` runs any other local bin (use it instead of `npx`).

## Code style

- TypeScript throughout, compiled under `tsconfig.base.json` — `strict`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly` — by the native TypeScript 7 compiler.
- Formatting is enforced by oxfmt through `vp fmt`; the house style is oxfmt's defaults (semicolons, double quotes, trailing commas, print width 100, Markdown prose unwrapped). The pre-commit hook formats staged files; don't fight it.
- Linting is enforced by oxlint through `vp lint`: the `@effect/tsgo` presets plus `@mpsuesser/oxlint-plugin-effect`'s recommended set. The `warn` tier is a staged rollout; see [AGENTS.md → Common pitfalls](AGENTS.md#common-pitfalls).
- Use Effect's `Schema` patterns; derive everything from a single resource definition where possible.
- Document public APIs with JSDoc (see [Documentation](#documentation)).

### The reformat commit

The whole repository was reformatted once, in a single isolated commit, when the toolchain moved to the Vite+ library standard: `2f7ad038eb9b870f65e6169fe5ecfbff14740c60` (`style: reformat the whole repository with vp fmt`). It is listed in [`.git-blame-ignore-revs`](.git-blame-ignore-revs); run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once per clone and `git blame` skips it (GitHub's blame view already does). Its only non-mechanical content is four `@ts-expect-error` directives moved onto the lines the formatter reflowed their expressions to.

## Documentation

Public API documentation follows the same JSDoc conventions as the `effect` package, so the surface reads consistently and is ready for API-doc generation. When you add or change a public export:

- **Module header.** Each module starts with a JSDoc block describing the module, ending with a `@since` tag.
- **Every public export** gets a JSDoc block containing, in order:
  1. A concise description of what it is and when to reach for it.
  2. An `@example` for the principal, user-facing APIs (constructors, combinators, guards) — it must compile and run under `vp run docgen`; see [AGENTS.md](AGENTS.md#vp-run-docgen-executes-your-examples) for the rules.
  3. A `@since` tag (use the version the symbol was introduced; `0.1.0` for the initial surface).
  4. A `@category` tag. Use a consistent vocabulary: `constructors`, `combinators`, `models`, `schemas`, `guards`, `accessors`, `layers`, `services`, `errors`, `constants`, `type-level`, `utils`.
- Keep the existing prose when refining docs — improve clarity, don't delete useful explanation.
- Implementation-only exports that aren't part of the public surface should be marked `@internal`.

`vp run check` type-checks the sources, tests and examples, so a broken example pattern that you copied into a doc will usually surface there; `vp run docgen` is what proves it runs.

## Testing

- Add tests for new behaviour. Unit tests live alongside their source files (e.g. `src/Resource.test.ts`) (imports follow [AGENTS.md → Conventions](AGENTS.md#conventions)); each worked example is a standalone workspace package under `examples/` that carries its own end-to-end tests (e.g. `examples/northwind/test/`). `vp run -r test:unit` runs them all across the workspace.
- Type-level expectations are asserted in `test/*.types.ts` files, not at runtime; see [AGENTS.md](AGENTS.md#type-level-tests-testtypests).
- `test/entry-points.test.ts` walks the real import graph of every entry point (the root, `./schema` and each module subpath such as `./Resource`), in `src/` and in `dist/`. It proves that the schema tier (`./schema` and the schema-tier module subpaths) resolves `effect` alone, never its HTTP surface, that no entry point resolves any package but `effect`, and that each module subpath is the same module as the root's namespace of that name.

## Changesets

This project uses [Changesets](https://github.com/changesets/changesets) to manage versions and changelogs. If your change affects the published package, add a changeset describing it:

```bash
pnpm changeset
```

Pick the appropriate bump (`patch` / `minor` / `major`) and write a user-facing summary. The changeset file is committed alongside your change; releases are published automatically when the "Version Packages" PR is merged into `trunk`. See [PUBLISHING.md](./PUBLISHING.md) for the full release flow and one-time maintainer setup.

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one job on every push and pull request, on the latest stable Node.js (`node-version: latest`; Release uses the same setup): the gates in [AGENTS.md → Verification](AGENTS.md#verification), build first, plus `pnpm audit --audit-level high`. The job name is the check name the `Default` ruleset on `trunk` requires, `Lint, type-check, build & test`, so renaming it blocks every PR. Installs are `pnpm install --frozen-lockfile --ignore-scripts` followed by an explicit `pnpm run prepare` (the composite action in `.github/actions/setup` explains the exception). [release.yml](.github/workflows/release.yml) runs the Changesets action on `trunk` under the protected `release` environment.

## Pre-PR checklist

1. The gates and the changeset in [AGENTS.md → Verification](AGENTS.md#verification).
2. `git fetch origin trunk && git rebase origin/trunk`
3. Docs: `README.md` for any exported change; `AGENTS.md` for a new term or invariant.

## Library template (programme standard)

The shape this repository has is the library standard every `@thomasfosterau/*` library repository is built on. To scaffold another one (or to bring an existing one up to date), copy these verbatim and then adjust names — the terms are `thomasfosterau/effect-web#1`'s, extended by the four pieces this repository contributed:

- **`pnpm-workspace.yaml`** — from `effect-drizzle-ext` / here: strict catalog with a named `catalogs: peers` entry for the published peer ranges (`effect` `>=4.0.0-rc.118`), `nodeLinker: hoisted`, `overrides` forcing `effect` / `vite` / `vitest` singletons, `minimumReleaseAge: 1440` with `minimumReleaseAgeExclude: ["@thomasfosterau/*"]`, `allowBuilds`. Pin set from the freshest application catalog (`effect`, `@effect/tsgo`, `@mpsuesser/oxlint-plugin-effect`, `vite-plus`, `vitest`) — except where the catalog header records a deliberate deviation, as this repository's `effect` pin does in tracking the `latest` dist-tag — checking `@effect/tsgo`'s `components` table for the `vite-plus` release whose `oxlint` it can patch.
- **`vite.config.ts`** (root, plus one per package) — from `effect-drizzle-ext` / here: oxlint with `@effect/tsgo/oxlint-presets` `recommended` + `@mpsuesser/oxlint-plugin-effect`'s recommended config and `vite-plus/prefer-vite-plus-imports: error`; a staged-rollout `warn` tier for preset rules with findings; the task graph `check` / `typecheck` / `build` / `typecheck:dist` / `test:unit` / `docgen` with `dependsOn: [{ task: "build", from: "dependencies" }]` where a package consumes a sibling's `dist/`.
- **`tsconfig.base.json`** — from `effect-drizzle-ext` / here: `$schema` from `@effect/tsgo`, `module: preserve`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, the `@effect/language-service` plugin with `ignoreEffectWarningsInTscExitCode`; the TypeScript 6/7 split (`typescript: npm:@typescript/typescript6@6.0.2`, `@typescript/native: npm:typescript@7.0.2`) with `prepare: vp config && effect-tsgo patch --typescript --oxlint`.
- **Build** — `vp pack` (tsdown, `platform: "neutral"`, `dts: true`, `format: "esm"`, `fixedExtension: false`), one bundle per entry point, `"sideEffects": false`, `exports` pointing at `dist/`, plus **`typecheck:dist`** (`tsconfig.dist.json` mapping the package name to the emitted `.d.ts`, with a `test/emitted/*.types.ts` fixture) — the emitted declarations are what consumers see, and they are not what `src/` resolves to. This repository deviates where it publishes a subpath per module (#385): `dts: false`, with the declarations emitted per module by `tsc` (`tsconfig.build.json` says why bundled declarations cannot serve module subpaths).
- **`.github/actions/setup`** + **`.github/workflows/ci.yml`** — from here: composite setup (`pnpm install --frozen-lockfile --ignore-scripts`, then the repository's own `pnpm run prepare` as its own step), task-cache restore, `vp run build` → `vp check` → `vp run check` → `vp run -r test:unit` → `vp run docgen` → `pnpm audit --audit-level high`; `permissions: {}` at the top of every workflow, `persist-credentials: false` on checkout, SHA-pinned actions.
- **`.github/workflows/release.yml`** + **`PUBLISHING.md`** + **`SECURITY.md`** — from here: OIDC trusted publishing via `pnpm publish --ignore-scripts` from the protected `release` environment, no `NPM_TOKEN`, `.changeset/config.json` schema 4.0.0 with `baseBranch: trunk`. Each setting and its reason: [SECURITY.md](SECURITY.md#supply-chain-hardening) and the comments in `release.yml`.
- **`.github/dependabot.yml`** — from `effect-drizzle-ext` / here: weekly, grouped `effect` / `vitest-toolchain`, `cooldown` 1 day excluding `@thomasfosterau/*`, version updates of the gitHead-locked set (`@effect/tsgo`, `typescript`, `@typescript/native`, `vite`, `vitest`, `vite-plus`) ignored while security updates stay on, the `github-actions` ecosystem.
- **`.claude/settings.json`**, **`.claude/hooks/session-start.sh`**, **`.claude/hooks/fallow-gate.sh`**, **`.fallowrc.json`**, **`.vite-hooks/pre-commit`**, **`.editorconfig`** — from `effect-drizzle-ext` / here. The session-start hook is what makes `vp` resolve in a non-interactive shell; the devcontainer's `postCreateCommand` invokes the same file.
- **`AGENTS.md`** as the file with `CLAUDE.md -> AGENTS.md`, a per-package `CLAUDE.md` carrying that package's import boundary in a multi-package workspace, `README.md`, `CONTRIBUTING.md`, `LICENSE` (MIT).
- **`docgen.json`** + `@effect/docgen` — from here: examples are compiled _and executed_ (`types: ["node"]` set explicitly; `tsx` in the catalog as its runtime); a `docgen` task and CI step of its own.
- **The type-level test slot** — from here: `test/*.types.ts` included by the root `tsconfig.json` (package name mapped to `./src`), asserted with `@ts-expect-error` and checked by `vp run check`; TypeScript 7 anchors overload failures per property, so a directive covers exactly the next line.
- **The reformat** — one isolated `vp fmt` commit, listed in `.git-blame-ignore-revs` and named in `CONTRIBUTING.md`.

Done when the gates in [AGENTS.md → Verification](AGENTS.md#verification) pass; CI is green on `trunk`; the `release` environment exists and the Release workflow opens a "Version Packages" PR when a changeset is present; a fresh agent session can run the gates without manual setup.

## Scope

This library provides a type-safe, spec-compliant JSON:API v1.1 layer on top of Effect's `HttpApi`: resources, errors, endpoints, typed query parameters, content-negotiation middleware and the atomic operations extension. Contributions should keep compliance a property of construction — derived from resource definitions rather than left to developer discipline — and compose with vanilla `HttpApi`, `HttpApiBuilder`, `HttpApiClient`, `HttpApiTest` and `OpenApi`.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
