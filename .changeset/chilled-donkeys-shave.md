---
"@thomasfosterau/effect-jsonapi": minor
---

Add `Include` — declare a resource's `?include=` surface once

Serving compound documents needs three things to agree: the whitelist of accepted dotted paths, the `included` union the success schema declares (`HttpApiBuilder` strips a resolved `included` the schema doesn't admit), and the advertised `include` parameter. Until now those were separate declarations over separate inputs, so they could drift.

`Include.make(resource, spec)` is one nested declaration all three project from:

```ts
const surface = Include.make(Article, {
  author: Person,
  comments: Include.nested(Comment, { author: Person }),
});

surface.paths; // ["author", "comments", "comments.author"] — typed literals
surface.included; // Schema.Union([Person, Comment])
surface.has("comments.editor"); // false — the whole dotted path is matched

Endpoint.get(Article, { include: surface }); // all three, from the one declaration
```

- The whitelist spells depth: `comments` being includable does not admit `comments.editor`.
- Nesting only ever _adds_ paths — `?include=comments` keeps meaning what it did.
- The union carries every depth, deduplicated by schema identity, so a walk that hoists a Comment and the Person behind it has both arms.
- Every key is checked against the resource's relationship graph (unknown key, `paginated` relationship, or wrong target) at compile time and again when the surface is built.

A surface is accepted wherever `include` is — `Endpoint.get` / `list` / `related`, `Query.schema`, `Query.Include` and `Group.resource` (top-level and per endpoint) — and on `get` / `list` / `related` it also derives the success document's `included` union.

Because the derivation recurses over the declaration rather than the relationship graph, a declared surface is not bound by the depth-2 ceiling `include: true` inherits; it is capped explicitly at `Include.MAX_DEPTH` (6) hops, where the type-level derivation truncates and `Include.make` throws.

`Include.paths(spec)` and `Include.included(spec)` are the same two projections standalone. `include: true` and `Query.IncludeOptions` are unchanged for consumers who don't opt in.

The module is schema-tier, so it is exported from `@thomasfosterau/effect-jsonapi/schema` as well as the package root: it derives the whitelist and the union from resource definitions alone, without resolving `effect/unstable/httpapi`.

Mutually-recursive resources are fully supported. The derivation recurses over the declaration you wrote, never over the resource graph, so an `Article` ⇄ `Comment` cycle costs it nothing and the `included` union terminates by construction.

The declared surface feeds the runtime half with no glue: `surface.paths` is the `includable` whitelist `Query.validateIncludePaths` checks a request against, and the same array is the `paths` argument to `Handlers.resolveIncluded`.
