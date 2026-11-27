# Architecture

Notes for contributors on how the modules fit together.

## Everything derives from `Resource.make`

A `Resource.make(type, { attributes, relationships, meta })` call is the single source of truth for a resource. Every other module takes resource definitions and derives schemas or endpoints from them:

- **`Resource.ts`**: the resource schema, id and identifier schemas, create / update payloads, and the allow-list helpers (`sortable`, `filterable`, `attributeKeys`, `includePaths`).
- **`Query.ts`**: the `include` / `fields` / `sort` / `page` / `filter` query schema.
- **`Document.ts`**: top-level document and collection schemas, with `included` derived from the relationship graph.
- **`Endpoint.ts`**: the `HttpApiEndpoint` definitions. Large from repetition, not from novel type logic.
- **`Handlers.ts`**: handler signatures and document builders typed against what an endpoint expects.

Imports point one way: `Resource.ts` imports neither `Query.ts` nor `Endpoint.ts`. `Query.ts` is generic over the structural shape a definition produces, so when tracing where a type comes from, follow the generic parameters rather than the imports.

## Core options, preset defaults

Where the specification lets a server choose (a status, a linkage policy, how strict to be about unknown members), the choice is an explicit option on the core constructor, and today's behaviour is its default or a named preset over it. Users take the preset, the core, or the core with a preset of their own. The conformance kit's `spec` tier is the contract every setting must keep; the `profile` tier holds this package's own opinions.

A policy read at request time belongs in `JsonApiConfig` (a `Context.Reference` the middleware reads when its layer is built), with the layer's own option overriding it. A policy that shapes a schema is fixed when the resource or endpoint is defined, so it stays a constructor option.

## Type machinery

`Resource.ts` and `Query.ts` hold most of the conditional and mapped types; start there with a type error that doesn't obviously belong to one endpoint.

`AsFields<T>` (`T extends Schema.Struct.Fields ? T : never`, with private copies in `Query.ts` and `Atomic.ts`) re-asserts the `Struct.Fields` constraint on a computed record that TypeScript cannot prove while its parameters are generic. Reach for it, not `as any`, when a generic helper that clearly produces struct fields fails that constraint.

effect's `HttpApiEndpoint` constructors guard `error` with an unexported conditional type (`ErrorNoStream`) that no generic error list satisfies, so `Endpoint.ts` carries expect-error directives. TypeScript 7 anchors the failed overload at each failing property, so they sit on `params:` / `query:` lines as well as `error:`.

## Flat and nested query schemas

`Query.schema` builds two structs for one query: a flat, bracket-keyed one (`filter[status]`, `page[limit]`), which is what `HttpApiEndpoint` decodes URL parameters into, and a nested one (`{ filter: {…}, page: {…} }`) for handlers and clients, related by a transformation. They are built side by side (`flatFields` / `nestedFields`): a new query family goes in both.

An explicit `filter: { key: Schema }` map registers one flat key per field. `filter: true` (the grammar) cannot be enumerated, so its flat side is a `Schema.StructWithRest` over any bracket suffix, plus a bare `filter` key so a malformed value still reaches the grammar's rejection.

## The built package

`vp pack` bundles one ESM entry per export; `tsc -p tsconfig.build.json` writes one `.d.ts` per source module, because a consumer's declaration emit cannot name a type inside a bundled chunk. What consumers see is therefore not what `src/` resolves to, which is what `test/entry-points.test.ts`, `test/emitted/*.types.ts` (`typecheck:dist`) and `test/declaration-emit.test.ts` check.
