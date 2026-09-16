---
"@thomasfosterau/effect-jsonapi": minor
---

Make mutually-recursive resource definitions authorable.

`Relationship.one(() => Person)` has always been a thunk, so the _runtime_ relationship graph could
contain cycles. Inference could not: `Resource.make`'s return type is inferred, so an
`Article` ⇄ `Comment` pair made each definition's type depend on the other's and TypeScript refused
both with `TS7022` / `TS7024`. The ordinary parent ⇄ child JSON:API graph therefore had to hide one
direction in a plain attribute (`productId`) and tell consumers about it out of band.

A cyclic pair is now authorable with the same escape Effect's recursive schemas use — an explicit
annotation on the recursive binding, which here is one `interface` per resource in the cycle:

```ts
const articleAttributes = { title: Schema.NonEmptyString }
const commentAttributes = { body: Schema.NonEmptyString }

interface Article extends Resource.Resource<
  "articles",
  typeof articleAttributes,
  {
    readonly comments: Relationship.many<Comment>
  }
> {}

interface Comment extends Resource.Resource<
  "comments",
  typeof commentAttributes,
  {
    readonly article: Relationship.one<Article>
  }
> {}

const Article: Article = Resource.make("articles", {
  attributes: articleAttributes,
  relationships: { comments: Relationship.many(() => Comment) }
})

const Comment: Comment = Resource.make("comments", {
  attributes: commentAttributes,
  relationships: { article: Relationship.one(() => Article) }
})
```

Attributes are hoisted to a `const` and referenced with `typeof`, so no attribute schema is
restated. All four relationship kinds may take part in a cycle, self-references included, and
everything derived from the definitions keeps working: `document()` / `collection()` (whose
`included` union stays one hop wide, never the transitive closure), `?include=` path derivation
(bounded by depth, not by the graph), create/update payloads, `Endpoint.*`, `Group.resource`,
`Query.schema`, `Resource.extend` and `Resource.family`.

Three supporting changes made it work:

- **New:** the lowercase descriptor types `Relationship.one`, `Relationship.optional`,
  `Relationship.many` and `Relationship.paginated` — the types the constructors of the same name
  produce, defaults included (`one` / `optional` default to not filterable). A resource definition
  is invariant in its relationship record, so an annotation has to name the type the constructor
  produced; these are it.
- **New:** `Resource.Definition<Type, Attributes, Rels, Meta, IdSchema>`, the parameter form of
  `Resource.Resource`, now used wherever the package takes a resource definition apart into its type
  parameters (`Endpoint.*`, `Group.resource`, `Resource.extend`, `Resource.family`). It reads `Type`
  off the definition's own `type` tag instead of inferring it structurally, which silently widened
  to `string` for an interface-annotated definition — taking every `Type`-derived default with it,
  starting with the endpoint path. As a type it is exactly `Resource.Resource`.
- `Relationship.SchemaFor` now selects on the descriptor's `kind` tag rather than matching
  `D extends One<infer R>`, and the descriptor interfaces carry a phantom `~target` member so the
  target can be read by a plain indexed access. Matching a descriptor against the candidate
  interfaces made TypeScript relate the target resource back into the mapped type it was computing,
  which is the loop a cyclic graph could not close (`TS2615`). The two selections agree on every
  descriptor. `Relationship.TargetOf<D>` reads that phantom and is exported alongside it.

The phantom member means a descriptor value assembled by hand (rather than through
`Relationship.one` / `optional` / `many` / `paginated`) no longer satisfies the descriptor
interfaces structurally. Use the constructors.
