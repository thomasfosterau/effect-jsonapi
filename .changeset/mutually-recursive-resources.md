---
"@thomasfosterau/effect-jsonapi": patch
---

**Mutually recursive resource definitions (`Article ⇄ Comment`) are authorable, and documented as
such.** The README listed them as unsupported — "TypeScript cannot infer two resource types that
reference each other" — and told you to model one direction as a filtered collection endpoint
instead. The premise is true and the conclusion was too strong: TypeScript cannot _infer_ the pair,
but it resolves them fine when each side's type is written out first, exactly as recursive `Schema`
definitions are always written — the cycle runs through a relationship descriptor's `ref` thunk, a
deferred position, which is what makes a pair of circular type aliases legal. Nothing in the library
was preventing it.

```ts
const articleAttributes = { title: Schema.NonEmptyString }
const commentAttributes = { body: Schema.NonEmptyString }

type ArticleResource = Resource.Resource<
  "articles",
  typeof articleAttributes,
  { comments: Relationship.Many<CommentResource> }
>
type CommentResource = Resource.Resource<
  "comments",
  typeof commentAttributes,
  { article: Relationship.One<ArticleResource, false> }
>

const Article: ArticleResource = Resource.make("articles", {
  attributes: articleAttributes,
  relationships: { comments: Relationship.many(() => Comment) }
})
const Comment: CommentResource = Resource.make("comments", {
  attributes: commentAttributes,
  relationships: { article: Relationship.one(() => Article) }
})
```

The annotation on each `const` breaks the inference cycle; the thunks need none of their own, and
the attribute maps are written once as values rather than restated. `type` aliases rather than
`interface`s, deliberately: both resolve the recursion, but an alias keeps the generic reference
intact, so `Resource.extend` and `Resource.annotate` still infer the resource's type tag from it.

Everything derived from the pair works in both directions, which is now pinned by tests rather than
assumed: `Resource.IncludePath` is exactly `"comments" | "comments.article"` and
`"article" | "article.comments"` — no widening to `string` — `?include=` across the cycle decodes and
is advertised, the `included` union is finite, the four write projections derive as usual with the
inverse to-one required at create, and `Resource.extend` / `Resource.annotate` work on a resource
that takes part in a cycle.

The include-depth bound is what keeps the derivation finite: paths are typed to two hops, so a cycle
contributes one hop back and stops. That bound is the general one, not something special to cycles,
and the runtime set `Query.Include` advertises matches it exactly.

Documentation and tests only — no API or behaviour change. The README's "Limitations" entry is
narrowed to what actually remains (the interface declaration), with a worked section covering it,
and `test/recursive-resources.types.ts` and `src/Resource.recursive.test.ts` pin both halves.
