---
"@thomasfosterau/effect-jsonapi": minor
---

**An Effect-native compound-document `include` resolver: `Handlers.resolveIncluded`.** Walking the
requested `?include=` paths — reading refs off relationship linkage, loading them, doing it again for
the next hop, deduplicating across paths and rows, dropping refs that don't resolve — was left
entirely to the consumer, and it is the same algorithm for every JSON:API server. It is now one call
(#106):

```ts
// One loader per resource type, called once per level with every id that level
// collected — so each is a single `WHERE id IN (…)`, never a lookup per row.
const targets = {
  people: (ids: ReadonlyArray<string>) => db.people.byIds(ids),
  comments: (ids: ReadonlyArray<string>) => db.comments.byIds(ids)
}

handlers.handle("list", ({ query }) =>
  listArticles(query).pipe(
    Effect.flatMap(({ items, total }) =>
      Handlers.resolveIncluded(items, query.include, targets).pipe(
        Effect.map((included) => Handlers.collection(items, { included, meta: { total } }))
      )
    )
  )
)
```

It is a plain `Effect` a handler composes — no service to provide, no runtime to set up — and the
same call serves one primary resource, a page of them, or `null`.

- **Batched per level, across the whole primary set.** Every parent's references for the current
  segment are collected and deduplicated before anything is loaded, then handed to the loaders as one
  batch per distinct type. `?include=author.employer` over a 50-article page is two loader calls, not
  a hundred.
- **One bucket keyed `(type, id)`.** Two paths or two rows reaching the same resource contribute it
  once; a shared path prefix costs no second query; a resource already in the primary `data` is never
  duplicated into `included`. Emission follows walk order, so a `get`'s `included` and a `list`'s
  agree.
- **Depth-capped and cycle-safe.** A cyclic graph (`articles → comments → articles`) revisits
  resources the document already holds, which are never re-loaded; `depth` (default `3`, the deepest
  path `Query.Include` legalises) bounds the hops, since §7.1 leaves the bound implementation-defined
  and an unbounded walk is a denial-of-service surface. `concurrency` bounds a level's fan-out.
- **An unresolvable ref is dropped, not a failure** — an unknown target type, an id the batch didn't
  return, a row the viewer may not see — while a genuine loader fault propagates and fails the
  document. `undefined` (not `[]`) when nothing was requested, so the caller omits the member.

Because every resource is reached _through_ a document resource's linkage, full linkage holds by
construction and `Handlers.buildIncluded`'s check becomes a guard rather than a live constraint.

New exports: `Handlers.resolveIncluded`, `Handlers.IncludeTarget`, `Handlers.IncludeTargets`,
`Handlers.ResolveIncludedOptions`, and the type-level `Handlers.IncludeTargetResource` /
`IncludeTargetError` / `IncludeTargetServices` for naming a registry's projections. Nothing existing
changes.
