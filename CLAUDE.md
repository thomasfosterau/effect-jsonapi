# CLAUDE.md

Guidance for working in this codebase. For setup and the day-to-day command
reference, see CONTRIBUTING.md. This file covers what isn't obvious from
skimming the source.

## `pnpm run docgen` executes your examples

`@effect/docgen` doesn't just type-check JSDoc `@example` blocks — it
**compiles them as ESM and runs them** (`pnpm run docgen`). Note this is a
separate command/CI step from `pnpm run check` (typecheck + lint +
format:check + test) — `check` passing does not mean your examples run; run
`docgen` too before you're done. A broken example fails the build, not a
lint warning.

Consequences for any `@example` in `src/*.ts`:

- It must be a **complete, self-contained program**: import everything it
  uses, including from the package root (`@thomasfosterau/effect-jsonapi`)
  exactly as a consumer would.
- **`declare const` is banned.** It emits no runtime value, so `docgen` fails
  at execution, not at type-check — the error is easy to misread as unrelated.
  If an example needs a value you don't want to construct for real (a
  handler's request context, a client), take it as a function parameter or
  build it with `Effect.gen`.
- It must actually run without throwing — `Effect.runPromise`/`runSync` (or
  leaving a `Effect.gen` unexecuted only if the surrounding example doesn't
  claim to run it) needs to succeed, not just type-check.
- Ground examples in real usage pulled from `examples/` or `test/` rather than
  inventing new call shapes — those are already known to compile and run.

This restriction is **specific to `src/*.ts` JSDoc examples**. `declare
const` is fine in `test/*.types.ts` (see below) — those files are asserted by
`tsc`, never executed by docgen or vitest.

## Architecture: everything derives from `Resource.make`

A `Resource.make(type, { attributes, relationships, meta })` call in
`src/Resource.ts` is the single source of truth for a resource. Every other
module takes a resource definition (or several) as input and derives schemas
or endpoints from it — nothing else declares resource shape independently:

- **`Resource.ts`** — the resource schema itself, id/identifier schemas,
  create/update payload schemas, `sortable`/`filterable`/`attributeKeys`
  helpers used to build allow-lists for other modules.
- **`Query.ts`** — given a resource (or an explicit sort/filter/page option
  set derived from one), builds the `include`/`fields`/`sort`/`page`/`filter`
  query-parameter schema.
- **`Document.ts`** — given a resource, builds the top-level JSON:API
  document/collection schemas, with `included` derived from the relationship
  graph.
- **`Endpoint.ts`** — given a resource (and a `Query.schema` built from it),
  builds the `HttpApiEndpoint` definitions (list/get/create/update/delete +
  relationship endpoints).
- **`Handlers.ts`** — types handler signatures against the `Document`/`Query`
  shapes an `Endpoint` expects, so a handler that doesn't match its endpoint
  is a compile error.

Note `Query.ts` does **not** import `Resource.ts` — it's generic over the
structural shape a resource definition produces (to avoid a `Resource.ts` ↔
`Endpoint.ts` ↔ `Query.ts` import cycle), not decoupled from the model. When
tracing "where does this type come from," follow the resource definition
through generic parameters, not `import` statements.

## Where the type machinery lives

`src/Resource.ts` (~2900 lines) and `src/Query.ts` (~1300 lines) carry almost
all the conditional/mapped-type work. `src/Endpoint.ts` (~2950 lines) is
large mostly from repetition (one block per CRUD/relationship endpoint kind),
not novel type-level logic — start in `Resource.ts`/`Query.ts` first when
debugging a type error that doesn't obviously belong to one endpoint.

**`AsFields<T>`** (`src/Resource.ts`, also mirrored where attribute/
relationship records get merged, e.g. `Endpoint.ts`'s `ExtendedAttributes`) is
the recurring escape hatch:

```ts
type AsFields<T> = T extends Schema.Struct.Fields ? T : never
```

Mapped/conditional types that _compute_ a `Schema.Struct.Fields`-shaped
record (e.g. merging base + extra attributes, or relationship descriptors)
can't be proven by TS to satisfy that constraint while their type parameters
are still generic, even though every concrete instantiation does satisfy it.
`AsFields` re-asserts the constraint at the point of use instead of loosening
it. If you hit a "does not satisfy the constraint `Struct.Fields`" error on a
generic helper that clearly produces struct fields, this is the pattern to
reach for — not `as any`.

## Type-level tests: `test/*.types.ts`

Compile-time invariants (what should and shouldn't type-check) live in
`test/*.types.ts`, not in `*.test.ts` runtime assertions. They're checked by
`pnpm run typecheck` (via `tsconfig.test.json`), never executed. The
assertion mechanism is `@ts-expect-error` immediately above a statement that
must fail to compile; a passing build means every expected error actually
fired (an unused `@ts-expect-error` is itself a `tsc` error). `declare const`
is fine here — these files are never run.

Add a case here (not a `.test.ts`) when you're asserting that something
_doesn't_ compile, or asserting an inferred type shape rather than a runtime
value.

## Wire format: flat vs. nested query schema

`Query.schema` builds two struct shapes for the same logical query, not one:

- A **flat**, bracket-keyed struct — `filter[status]`, `page[limit]`,
  `fields[articles]` — because that's what JSON:API actually puts on the
  wire and what `HttpApiEndpoint` decodes URL search params into.
- A **nested**, fully-decoded struct — `{ filter: {...}, page: {...},
fields: { articles: [...] } }` — because that's what's ergonomic for
  handler code and client call sites.

These aren't two independent schemas kept in sync by hand: the flat struct is
built field-by-field alongside the nested one in the same function
(`src/Query.ts`, look for `flatFields`/`nestedFields`), then related by a
transformation. If you add a new query family, add it to _both_ field
records in the same place, not just the one that looks user-facing — a family
present only in the nested struct won't have a wire representation at all,
and one present only in the flat struct won't decode into anything handler
code can read.

The same split explains why filtering has two forms with different flat
encodings: an explicit `filter: { key: Schema }` map registers one
`filter[key]` flat field per declared key (a fixed, enumerable set), while
`filter: true` (the open, spec-shaped filter grammar derived from the
resource's `filter: true`-marked attributes) can't be enumerated ahead of
time — arbitrary nesting like `filter[age][gt]=18` — so its flat struct
instead uses `Schema.StructWithRest` to accept any bracket suffix matching
the grammar, plus one explicit bare `filter` key so a malformed
(non-bracketed) value still reaches the grammar's own rejection instead of
being silently dropped as an excess property.
