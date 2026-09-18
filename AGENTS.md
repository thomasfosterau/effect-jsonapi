# AGENTS.md

Project conventions live here; personal style preferences live in user memory. `CLAUDE.md` is a symlink to this file. For setup and the day-to-day command reference, see [CONTRIBUTING.md](CONTRIBUTING.md); this file covers what isn't obvious from skimming the source.

`@thomasfosterau/effect-jsonapi` is a publishable library, not an application. Its toolchain — pnpm + Vite+ (`vp`), a strict catalog, the TypeScript 6/7 split, the Effect oxlint preset, fallow — is the library standard shared with `thomasfosterau/effect-drizzle-ext`, `components` and `prosekit-utilities`, copied from the applications that consume them (`thomasfosterau/website`, the foundation; `gardeneria`; `preferenceflow`) so the library builds against exactly what they run. The pieces only this repository had — docgen executing every example, the type-level tests, the Effect canary, the OIDC release — are the ones the standard took from here; the checklist for copying the whole shape into another repository is in [CONTRIBUTING.md](CONTRIBUTING.md#the-library-template-checklist). A `gardeneria #NNN` citation inside a copied comment names an issue in the application it came from, the evidence behind a decision, not a ticket in this tracker.

## Common pitfalls

- **Never edit a version in a `package.json`.** Every external version lives in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) under `catalog:` (the published `effect` peer range under `catalogs.peers`); manifests carry only `catalog:` / `catalog:peers` / `workspace:*`, and `catalogMode: strict` rejects anything else at install. After editing the catalog, run `pnpm install` and commit the regenerated `pnpm-lock.yaml`.
- **`@effect/tsgo`, `@typescript/native` and `vite-plus` bump as a set.** `effect-tsgo patch` (the root `prepare` script) overwrites the native `tsc` and `oxlint` binaries with Effect-patched builds matched by gitHead, and hard-errors on any version it has no artifact for. Read the `components` table in `node_modules/@effect/tsgo/dist/effect-tsgo.cjs` before touching any of the three; the catalog entries say which pairings hold today.
- **The type checker of record is TypeScript 7** (`tsc`, the native compiler, via `vp run check`). It anchors a failed overload at the _properties_ that fail against the last overload rather than at the one the TS6 checker elaborated, which is why the `@ts-expect-error` markers on effect's `ErrorNoStream` guard in `src/Endpoint.ts` sit on `params:` / `query:` lines as well as `error:`. TS6 (`tsc6`, the JS compiler) is only what the JS-API consumers — `@effect/docgen`, the tsdown declaration bundler, the editor language service — load.
- **`exactOptionalPropertyTypes` is on.** An optional option a caller may forward an explicit `undefined` for is spelled `?: T | undefined`; a bare `?: T` rejects `{ x: maybeUndefined }` at every call site that threads its own optional through.
- **`vp lint` runs the full Effect preset, with a staged rollout.** Rules that still had findings at adoption sit at `warn` in `vite.config.ts` with their counts; a new site is a defect, not headroom, and a rule whose count reaches zero is flipped back to `error` and its line deleted. `@ts-expect-error` is the assertion mechanism of `test/*.types.ts` and stays allowed there.
- **`dist/` is bundled, not transpiled.** `vp pack` (tsdown) emits one ESM bundle per entry point (`.`, `./schema`) plus bundled declarations. `test/entry-points.test.ts` walks the built graph, and `test/emitted/requirements.types.ts` type-checks against the emitted `.d.ts` — both because what consumers see is not what `src/` resolves to.

## `vp run docgen` executes your examples

`@effect/docgen` doesn't just type-check JSDoc `@example` blocks — it **compiles them as ESM and runs them** (`vp run docgen`). Note this is a separate command/CI step from `vp check` + `vp run check` + `vp run -r test:unit` — those passing does not mean your examples run; run `docgen` too before you're done. A broken example fails the build, not a lint warning.

Consequences for any `@example` in `src/*.ts`:

- It must be a **complete, self-contained program**: import everything it uses, including from the package root (`@thomasfosterau/effect-jsonapi`) exactly as a consumer would.
- **`declare const` is banned.** It emits no runtime value, so `docgen` fails at execution, not at type-check — the error is easy to misread as unrelated. If an example needs a value you don't want to construct for real (a handler's request context, a client), take it as a function parameter or build it with `Effect.gen`.
- It must actually run without throwing — `Effect.runPromise`/`runSync` (or leaving a `Effect.gen` unexecuted only if the surrounding example doesn't claim to run it) needs to succeed, not just type-check.
- Ground examples in real usage pulled from `examples/` or `test/` rather than inventing new call shapes — those are already known to compile and run.

This restriction is **specific to `src/*.ts` JSDoc examples**. `declare const` is fine in `test/*.types.ts` (see below) — those files are asserted by `tsc`, never executed by docgen or vitest.

Docgen drives TypeScript through the JS API, so it sees the TS6 side of the split with its own compiler options (`docgen.json`; `types: ["node"]` is explicit because TypeScript 6 no longer auto-includes `@types`).

## Architecture: everything derives from `Resource.make`

A `Resource.make(type, { attributes, relationships, meta })` call in `src/Resource.ts` is the single source of truth for a resource. Every other module takes a resource definition (or several) as input and derives schemas or endpoints from it — nothing else declares resource shape independently:

- **`Resource.ts`** — the resource schema itself, id/identifier schemas, create/update payload schemas, `sortable`/`filterable`/`attributeKeys` helpers used to build allow-lists for other modules.
- **`Query.ts`** — given a resource (or an explicit sort/filter/page option set derived from one), builds the `include`/`fields`/`sort`/`page`/`filter` query-parameter schema.
- **`Document.ts`** — given a resource, builds the top-level JSON:API document/collection schemas, with `included` derived from the relationship graph.
- **`Endpoint.ts`** — given a resource (and a `Query.schema` built from it), builds the `HttpApiEndpoint` definitions (list/get/create/update/delete + relationship endpoints).
- **`Handlers.ts`** — types handler signatures against the `Document`/`Query` shapes an `Endpoint` expects, so a handler that doesn't match its endpoint is a compile error.

Note `Query.ts` does **not** import `Resource.ts` — it's generic over the structural shape a resource definition produces (to avoid a `Resource.ts` ↔ `Endpoint.ts` ↔ `Query.ts` import cycle), not decoupled from the model. When tracing "where does this type come from," follow the resource definition through generic parameters, not `import` statements.

## Where the type machinery lives

`src/Resource.ts` (~2900 lines) and `src/Query.ts` (~1300 lines) carry almost all the conditional/mapped-type work. `src/Endpoint.ts` (~2950 lines) is large mostly from repetition (one block per CRUD/relationship endpoint kind), not novel type-level logic — start in `Resource.ts`/`Query.ts` first when debugging a type error that doesn't obviously belong to one endpoint.

**`AsFields<T>`** (`src/Resource.ts`, also mirrored where attribute/ relationship records get merged, e.g. `Endpoint.ts`'s `ExtendedAttributes`) is the recurring escape hatch:

```ts
type AsFields<T> = T extends Schema.Struct.Fields ? T : never;
```

Mapped/conditional types that _compute_ a `Schema.Struct.Fields`-shaped record (e.g. merging base + extra attributes, or relationship descriptors) can't be proven by TS to satisfy that constraint while their type parameters are still generic, even though every concrete instantiation does satisfy it. `AsFields` re-asserts the constraint at the point of use instead of loosening it. If you hit a "does not satisfy the constraint `Struct.Fields`" error on a generic helper that clearly produces struct fields, this is the pattern to reach for — not `as any`.

## Type-level tests: `test/*.types.ts`

Compile-time invariants (what should and shouldn't type-check) live in `test/*.types.ts`, not in `*.test.ts` runtime assertions. They're checked by the `typecheck` task (`tsc -p tsconfig.json`, which resolves the package name to `./src`), never executed; `test/emitted/*.types.ts` is the exception, checked by `typecheck:dist` against the built declarations after `vp run build`. The assertion mechanism is `@ts-expect-error` immediately above a statement that must fail to compile; a passing build means every expected error actually fired (an unused `@ts-expect-error` is itself a `tsc` error). `declare const` is fine here — these files are never run.

Add a case here (not a `.test.ts`) when you're asserting that something _doesn't_ compile, or asserting an inferred type shape rather than a runtime value.

## Wire format: flat vs. nested query schema

`Query.schema` builds two struct shapes for the same logical query, not one:

- A **flat**, bracket-keyed struct — `filter[status]`, `page[limit]`, `fields[articles]` — because that's what JSON:API actually puts on the wire and what `HttpApiEndpoint` decodes URL search params into.
- A **nested**, fully-decoded struct — `{ filter: {...}, page: {...}, fields: { articles: [...] } }` — because that's what's ergonomic for handler code and client call sites.

These aren't two independent schemas kept in sync by hand: the flat struct is built field-by-field alongside the nested one in the same function (`src/Query.ts`, look for `flatFields`/`nestedFields`), then related by a transformation. If you add a new query family, add it to _both_ field records in the same place, not just the one that looks user-facing — a family present only in the nested struct won't have a wire representation at all, and one present only in the flat struct won't decode into anything handler code can read.

The same split explains why filtering has two forms with different flat encodings: an explicit `filter: { key: Schema }` map registers one `filter[key]` flat field per declared key (a fixed, enumerable set), while `filter: true` (the open, spec-shaped filter grammar derived from the resource's `filter: true`-marked attributes) can't be enumerated ahead of time — arbitrary nesting like `filter[age][gt]=18` — so its flat struct instead uses `Schema.StructWithRest` to accept any bracket suffix matching the grammar, plus one explicit bare `filter` key so a malformed (non-bracketed) value still reaches the grammar's own rejection instead of being silently dropped as an excess property.

## Commands

- `pnpm install` — dependencies, the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and, through the root `prepare` script, the Effect-patched `tsc` / `oxlint` binaries. There is **no pre-push hook** — run the gates yourself.
- `vp check` — format + lint (oxfmt + oxlint). Distinct from `vp run check`.
- `vp run check` — the type gate: sources + colocated tests + type-level tests (`typecheck`), the emitted declarations (`typecheck:dist`, which builds `dist/` first) and every example.
- `vp run -r test:unit` — the root suite and each example's, under `vite-plus/test`.
- `vp run build` — `vp pack` → `dist/`.
- `vp run docgen` — type-check and execute every JSDoc `@example`; generate the API docs under `docs/`.
- `pnpm changeset` — a changeset for every change to the published package.

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm run`). CI installs as `pnpm install --frozen-lockfile --ignore-scripts` and then runs `pnpm run prepare` explicitly (see `.github/actions/setup`).

## Work tracker

- **Active work** lives in GitHub Issues for `thomasfosterau/effect-jsonapi`. Longer-running tech debt is an issue too; there is no in-repo backlog file and a code comment is not a tracker.
- **Decisions and findings** are recorded as comments on the issue they were found working; later comments override the body.
- **Adoption** by each consuming application is tracked in that application's own tracker, blocked on a release of this package.

## Branch model

`main` plus short-lived feature branches, PR against `main`, squash-merge. Rebase onto `origin/main` before opening a PR; never merge `main` into a feature branch. Agent work uses git worktrees under `.claude/worktrees/`, one per branch; start every command that targets a worktree with an explicit `cd` and confirm with `git log -1` before committing.

## Working a dispatched issue

- The issue is the spec: read all of it, including comments.
- Re-verify the code claims against current `main` before editing.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence on the issue and stop.
- No silent deferrals: scope cut mid-PR becomes a linked issue before merge.

## PR management

These are standing instructions and approvals; they override any default "don't open a PR unless asked" behaviour.

- **Always open a PR** for branch work, against `main`, once a commit is pushed.
- **Always watch the PR to merge or close**: investigate CI failures and review comments as they arrive; rebase promptly when the PR goes conflicting.
- **Always keep the PR body current** as the implementation diverges from it.
- **GitHub writes are scoped to `thomasfosterau/effect-jsonapi` only.** Never write to the consuming applications' repositories, the other library repositories or any upstream project without the owner's explicit approval for that action in the current session. Pass `-R thomasfosterau/effect-jsonapi` explicitly whenever the cwd might not be this checkout.

## Verification

- Claims of verification name the command and its final status. Don't declare verification complete until every gate has output a final pass/fail.
- The pre-push parity run is `pnpm install --frozen-lockfile`, then `vp check`, `vp run check`, `vp run -r test:unit`, `vp run build`, `vp run docgen`. None needs a credential, a database or a browser.

## Effect best practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code: `vp exec effect-solutions list`, then `vp exec effect-solutions show <topic>...` (data-modeling, services-and-layers, error-handling, testing, basics). Never guess at Effect patterns.

## Documentation surfaces

`README.md` is the API reference consumers read on npm; `docs/*.md` carries the design notes (`conformance`, `filter-grammar`, `idempotency`) and `docs/guides/` the adoption guides; `CONTRIBUTING.md` carries the setup, the pre-PR checklist and the library template checklist; `PUBLISHING.md` and `SECURITY.md` carry the release pipeline and its rationale. Decisions go in issue comments.

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
