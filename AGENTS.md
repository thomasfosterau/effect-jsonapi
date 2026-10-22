# AGENTS.md

`CLAUDE.md` is a symlink to this file. `@thomasfosterau/effect-jsonapi` is a publishable library (entry points `.`, `./schema` and one subpath per module, `./Resource`, `./Endpoint`, …), consumed by the website, gardeneria and preferenceflow apps. Its toolchain is the programme's library standard (checklist: [CONTRIBUTING.md](CONTRIBUTING.md#library-template-programme-standard)), with deviations listed at the top of `pnpm-workspace.yaml`. A `gardeneria #NNN` citation in a copied comment names an issue in that app, not this tracker.

## Common pitfalls

- **Versions live only in the `pnpm-workspace.yaml` catalog** (`catalogMode: strict`; peer ranges under `catalogs.peers`). After editing it, run `pnpm install` and commit `pnpm-lock.yaml` — a stale lockfile fails CI with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.
- **`@effect/tsgo`, `@typescript/native` and `vite-plus` bump as a set** — read the comment on `@effect/tsgo` in `pnpm-workspace.yaml` first; an unsupported pairing fails `pnpm install` (the `prepare` script's `effect-tsgo patch` hard-errors).
- **The type checker of record is TypeScript 7** (`tsc`, the native compiler, via `vp run check`). It anchors a failed overload at the _properties_ that fail against the last overload rather than at the one the TS6 checker elaborated, which is why the `@ts-expect-error` markers on effect's `ErrorNoStream` guard in `src/Endpoint.ts` sit on `params:` / `query:` lines as well as `error:`. TS6 (`tsc6`, the JS compiler) is only what the JS-API consumers — `test/entry-points.test.ts`, the tsdown declaration bundler, the editor language service — load. `@effect/docgen` is not one of them: it parses with a compiler bundled in its own dependencies (see [below](#vp-run-docgen-executes-your-examples)).
- **`vp lint` runs the full Effect preset with a staged rollout.** The `warn` tier in `vite.config.ts` is debt, not headroom: fix any new site, and when a rule's count reaches zero flip it to `error` and delete its line. `@ts-expect-error` is the assertion mechanism of `test/*.types.ts` and stays allowed there.
- **`dist/` JavaScript is bundled; its declarations are not.** `vp pack` (tsdown) emits one ESM entry per export (`.`, `./schema` and each module subpath) with shared code in hashed chunks; `tsc -p tsconfig.build.json` then writes one `.d.ts` per source module, because a consumer's declaration emit cannot name a type in a bundled chunk (#385). `test/entry-points.test.ts` walks the built graph, `test/emitted/*.types.ts` type-check against the emitted `.d.ts`, and `test/declaration-emit.test.ts` compiles a consumer through `node_modules` — all because what consumers see is not what `src/` resolves to.

## Conventions

- **`exactOptionalPropertyTypes` is on.** An optional option a caller may forward an explicit `undefined` for is spelled `?: T | undefined`; a bare `?: T` rejects `{ x: maybeUndefined }` at every call site that threads its own optional through.
- **Relative imports carry a `.js` extension** (`./Resource.js`), unlike the `.ts` used in effect-web and prosekit-utilities.
- **Tests import from `vite-plus/test`**, never `vitest`.
- **Every export has a doc comment** with a summary, an `@example` for principal APIs, `@since` and a `@category` from the vocabulary in [CONTRIBUTING.md](CONTRIBUTING.md#documentation).
- **Schema-backed errors are `Schema.TaggedError<Self>()(tag, fields)`** — the spelling in the pinned `effect`; `Schema.TaggedErrorClass` was the beta-line name.

### `vp run docgen` executes your examples

`vp run docgen` doesn't just type-check JSDoc `@example` blocks — it **compiles them as ESM and runs them**. `@effect/docgen` covers the examples on modules, functions, constants, types, namespaces and exports, and on a class's own doc comment, its methods and static methods, and its non-static, non-`private` properties. It reads neither a constructor's doc comment nor a static property's — it neither prints nor checks them — so put such an example on the class instead. Note this is a separate command/CI step from `vp check` + `vp run check` + `vp run -r test:unit` — those passing does not mean your examples run; run `docgen` too before you're done. A broken example fails the build, not a lint warning.

Consequences for any `@example` in `src/*.ts`:

- It must be a **complete, self-contained program**: import everything it uses, including from the package root (`@thomasfosterau/effect-jsonapi`) exactly as a consumer would.
- **`declare const` is banned.** It emits no runtime value, so `docgen` fails at execution, not at type-check — the error is easy to misread as unrelated. If an example needs a value you don't want to construct for real (a handler's request context, a client), take it as a function parameter or build it with `Effect.gen`.
- It must actually run without throwing — `Effect.runPromise`/`runSync` (or leaving a `Effect.gen` unexecuted only if the surrounding example doesn't claim to run it) needs to succeed, not just type-check.
- Ground examples in real usage pulled from `examples/` or `test/` rather than inventing new call shapes — those are already known to compile and run.

This restriction is **specific to `src/*.ts` JSDoc examples**. `declare const` is fine in `test/*.types.ts` (see below) — those files are asserted by `tsc`, never executed by docgen or vitest. `src/index.ts` is excluded from docgen (`docgen.json`), so nothing executes its module doc; keep it free of code samples.

Docgen (4.x) parses `src/` under `parseCompilerOptions` in `docgen.json` with the TypeScript 6.0 that its `ts-morph` dependency bundles, never the workspace's TS6 alias (#343). It compiles the examples by spawning the `tsc` on `PATH` (its `tscExecutable` option), which under `vp run` is the native TS7 `tsc`, under `examplesCompilerOptions`, then runs them with `tsx` — only because `docgen.json` sets `"runExamples": true`; the default is type-check only, so dropping the key silently stops the examples running. It rewrites no imports: an example's `@thomasfosterau/effect-jsonapi` imports resolve through the package's own `exports`, i.e. against `dist/`, which is why the `docgen` task depends on `build`. `types: ["node"]` is explicit in both option sets because TypeScript 6 and later no longer auto-include `@types`.

Three rules follow from that pipeline:

- **Import assertion functions by name** (`import { strictEqual } from "node:assert";`). Docgen injects no imports, so a bare `assert.…` is an unknown name.
- **Fence every `@example` as `ts`.** Docgen extracts only fenced code whose info string starts with `ts` / `typescript`; an unfenced example is printed but never checked.
- **A `ts` fence in a doc comment's description is an example too.** Docgen type-checks and runs every such fence in a description as well as under `@example`. Fence a type sketch that is not a complete program as `ts skip-type-checking` (docgen skips it and prints a plain `ts` fence).

## Architecture

### Everything derives from `Resource.make`

A `Resource.make(type, { attributes, relationships, meta })` call in `src/Resource.ts` is the single source of truth for a resource. Every other module takes a resource definition (or several) as input and derives schemas or endpoints from it — nothing else declares resource shape independently:

- **`Resource.ts`** — the resource schema itself, id/identifier schemas, create/update payload schemas, `sortable`/`filterable`/`attributeKeys` helpers used to build allow-lists for other modules.
- **`Query.ts`** — given a resource (or an explicit sort/filter/page option set derived from one), builds the `include`/`fields`/`sort`/`page`/`filter` query-parameter schema.
- **`Document.ts`** — given a resource, builds the top-level JSON:API document/collection schemas, with `included` derived from the relationship graph.
- **`Endpoint.ts`** — given a resource (and a `Query.schema` built from it), builds the `HttpApiEndpoint` definitions (list/get/create/update/delete + relationship endpoints).
- **`Handlers.ts`** — types handler signatures against the `Document`/`Query` shapes an `Endpoint` expects, so a handler that doesn't match its endpoint is a compile error.

**Import direction is one-way: `Resource.ts` imports neither `Query.ts` nor `Endpoint.ts`.** `Query.ts` uses `Resource.ts`'s allow-list helpers (`allTargets`, `attributeKeys`, `filterable`, `includePaths`) and `Endpoint.ts` uses both. Reversing any edge creates a cycle. `Query.ts` is generic over the structural shape a resource definition produces rather than over the `Resource` type, so when tracing "where does this type come from", follow the resource definition through generic parameters, not through `import` statements.

### Where the type machinery lives

`src/Resource.ts` and `src/Query.ts` carry almost all the conditional/mapped-type work. `src/Endpoint.ts` is large mostly from repetition (one block per CRUD/relationship endpoint kind), not novel type-level logic — start in `Resource.ts`/`Query.ts` first when debugging a type error that doesn't obviously belong to one endpoint.

**`AsFields<T>`** (`src/Resource.ts`, with private copies in `src/Query.ts` and `src/Atomic.ts`) is the recurring escape hatch:

```ts
type AsFields<T> = T extends Schema.Struct.Fields ? T : never;
```

Mapped/conditional types that _compute_ a `Schema.Struct.Fields`-shaped record (e.g. merging base + extra attributes, or relationship descriptors) can't be proven by TS to satisfy that constraint while their type parameters are still generic, even though every concrete instantiation does satisfy it. `AsFields` re-asserts the constraint at the point of use instead of loosening it. If you hit a "does not satisfy the constraint `Struct.Fields`" error on a generic helper that clearly produces struct fields, this is the pattern to reach for — not `as any`.

### Type-level tests: `test/*.types.ts`

Compile-time invariants (what should and shouldn't type-check) live in `test/*.types.ts`, not in `*.test.ts` runtime assertions. They're checked by the `typecheck` task (`tsc -p tsconfig.json`, which resolves the package name to `./src`), never executed; `test/emitted/*.types.ts` is the exception, checked by `typecheck:dist` against the built declarations after `vp run build`. The assertion mechanism is `@ts-expect-error` immediately above a statement that must fail to compile; a passing build means every expected error actually fired (an unused `@ts-expect-error` is itself a `tsc` error). `declare const` is fine here — these files are never run.

Add a case here (not a `.test.ts`) when you're asserting that something _doesn't_ compile, or asserting an inferred type shape rather than a runtime value.

### Wire format: flat vs. nested query schema

`Query.schema` builds two struct shapes for the same logical query, not one:

- A **flat**, bracket-keyed struct — `filter[status]`, `page[limit]`, `fields[articles]` — because that's what JSON:API actually puts on the wire and what `HttpApiEndpoint` decodes URL search params into.
- A **nested**, fully-decoded struct — `{ filter: {...}, page: {...}, fields: { articles: [...] } }` — because that's what's ergonomic for handler code and client call sites.

These aren't two independent schemas kept in sync by hand: the flat struct is built field-by-field alongside the nested one in the same function (`src/Query.ts`, look for `flatFields`/`nestedFields`), then related by a transformation. If you add a new query family, add it to _both_ field records in the same place, not just the one that looks user-facing — a family present only in the nested struct won't have a wire representation at all, and one present only in the flat struct won't decode into anything handler code can read.

The same split explains why filtering has two forms with different flat encodings: an explicit `filter: { key: Schema }` map registers one `filter[key]` flat field per declared key (a fixed, enumerable set), while `filter: true` (the open, spec-shaped filter grammar derived from the resource's `filter: true`-marked attributes) can't be enumerated ahead of time — arbitrary nesting like `filter[age][gt]=18` — so its flat struct instead uses `Schema.StructWithRest` to accept any bracket suffix matching the grammar, plus one explicit bare `filter` key so a malformed (non-bracketed) value still reaches the grammar's own rejection instead of being silently dropped as an excess property.

## Commands

- `pnpm install` — dependencies, the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and, through the root `prepare` script, the Effect-patched `tsc` / `oxlint` binaries. There is **no pre-push hook** — run the gates yourself.
- `vp check` — format + lint (Oxfmt + Oxlint). `vp run check` — the type gate: sources + colocated tests + type-level tests (`typecheck`), the emitted declarations (`typecheck:dist`, which builds `dist/` first) and every example. They are different commands.
- `vp run -r test:unit` — the root suite and each example's, under `vite-plus/test`.
- `vp run build` — `vp pack`, then `tsc -p tsconfig.build.json` → `dist/`.
- `vp run docgen` — build `dist/`, then type-check and execute every JSDoc `@example`; generate the API docs under `docs/`.
- `fallow audit --base origin/trunk` — change-set review (dead code, complexity, duplication); not a CI gate.
- `pnpm changeset` — add a changeset.

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm run`). CI installs as `pnpm install --frozen-lockfile --ignore-scripts` and then runs `pnpm run prepare` explicitly (see `.github/actions/setup`).

## Verification

Before you report work as done, run the gates below in order and quote each command with its final pass/fail. If a gate can't run here, say which and why in the PR body; never imply it ran.

1. `pnpm install --frozen-lockfile`
2. `vp run build` — first, as in CI: `typecheck:dist` (the emitted-declaration checks, `test/emitted/*`), `test/entry-points.test.ts` and `vp run docgen` read `dist/` (docgen's examples import the package by name, which resolves through its `exports`).
3. `vp check`
4. `vp run check`
5. `vp run -r test:unit`
6. `vp run docgen`
7. `fallow audit --base origin/trunk`
8. A changeset when the change alters published behaviour (rule: [Branches and pull requests](#branches-and-pull-requests)).

None needs a credential, a database, a browser or Docker. CI also runs `pnpm audit --audit-level high`.

## Branches and pull requests

Branch off `trunk`; PR against `trunk`; squash-merge. Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges). Name branches `issue-<n>-<slug>`. Agent work uses git worktrees under `.claude/worktrees/`, one per branch; start every command that targets a worktree with an explicit `cd` and confirm with `git log -1` before committing.

These are standing instructions and approvals; they override any default "don't open a PR unless asked" behaviour.

- **Always open a PR** for branch work, against `trunk`, once a commit is pushed. Fill `.github/pull_request_template.md`.
- **Always watch the PR to merge or close**: investigate CI failures and review comments as they arrive; rebase promptly when the PR goes conflicting.
- **Always keep the PR body current** as the implementation diverges from it.
- **Every change to the published package's behaviour carries a changeset** (`pnpm changeset`); docs-, CI- and tooling-only changes need none. Never publish or version by hand: the Release workflow opens the "Version Packages" PR and the owner merges it ([PUBLISHING.md](PUBLISHING.md)).
- **GitHub writes go to `thomasfosterau/effect-jsonapi` only** — never the consuming applications, the other library repositories or an upstream project without the owner's explicit approval for that action in the current session. Pass `-R thomasfosterau/effect-jsonapi` whenever the cwd might be another checkout. Use the `gh` CLI for GitHub operations, even when GitHub MCP tools are available.

## Work tracker

Issues are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO.

- **The issue is the spec** — read all of it, including comments; later comments override the body. Re-verify its code claims against current `trunk` before editing.
- **Decisions and findings** are recorded as comments on the issue they were found working.
- **Stop-and-report is a valid outcome:** on a blocker outside the issue's scope, comment the evidence on the issue and stop.
- **No silent deferrals:** scope cut mid-PR becomes a linked issue before merge.
- **Adoption** by each consuming application is tracked in that application's own tracker, blocked on a release of this package.

## Effect

**IMPORTANT:** Consult effect-solutions before writing Effect code (`vp exec effect-solutions list`, then `vp exec effect-solutions show <topic>…`: data-modeling, services-and-layers, error-handling, testing, basics); never guess at an Effect pattern.

The pinned version is the `effect` entry in `pnpm-workspace.yaml`. In that version the HTTP API modules are `effect/http-api` and `effect/http` — not `effect/unstable/httpapi`, and there is no `@effect/platform`. When effect-solutions and the code disagree, the code (and `node_modules/effect/dist/*.d.ts`) wins.

## Agent sessions

The SessionStart hook (`.claude/hooks/session-start.sh`, also the devcontainer's `postCreateCommand`) runs `vp install --frozen-lockfile` (which applies the tsgo patch) and links `vp`, `tsx` and `fallow` onto PATH for non-interactive shells. It hydrates no secrets; every gate runs offline. A PostToolUse hook runs `vp fmt` on each edited file, and a PreToolUse hook (`.claude/hooks/fallow-gate.sh`) runs the fallow gate before `git commit` / `git push`.

## Documentation surfaces

`README.md` is the API reference consumers read on npm; `docs/*.md` carries the design notes (`conformance`, `filter-grammar`, `idempotency`) and `docs/guides/` the adoption guides; `CONTRIBUTING.md` carries the setup, the documentation conventions and the library template checklist; `SECURITY.md` carries the supply-chain rationale and `PUBLISHING.md` the release flow and owner setup. Decisions go in issue comments.

---

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.

## Fallow task map

| When the agent is about to... | Run |
| --- | --- |
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base <ref>` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| understand a finding | `fallow explain <issue-type>` |
