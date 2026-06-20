---
"@thomasfosterau/effect-jsonapi": minor
---

**Whole-resource endpoint generation:** `Endpoint.resource` and `Group.resource` derive an entire JSON:API endpoint set from a single resource definition — the full CRUD surface plus, for every relationship, the `related` and linkage endpoints appropriate to its kind — with `include` / `fields` / `sort` query parameters derived from the resource graph.

```ts
// The whole group, fully typed, in one call:
const articles = Group.resource(Article, {
  errors: [ArticleNotFound],
  page: Query.Page.Offset,
  filter: { author: Schema.optionalKey(Schema.String) }
})

// Or get the endpoints as a tuple to compose with Group.make:
const articles = Group.make(
  Article,
  ...Endpoint.resource(Article, { errors: [ArticleNotFound] }),
  Endpoint.list(Article, { name: "search", path: "/articles/search", filter: { q: Schema.String } })
)
```

Defaults emit all five CRUD operations and every relationship's endpoints with `include` / `fields` / `sort` enabled; `page` and `filter` stay opt-in (their semantics are application-defined), and `errors` is applied uniformly. Everything is overridable: `endpoints` selects the CRUD operations, `relationships: false` drops the relationship endpoints, and `include` / `fields` / `sort` can be disabled or narrowed. The result is plain `HttpApiEndpoint` / `HttpApiGroup` values, so it composes with everything as before. See `Endpoint.ResourceOptions`.

**Breaking:** `Endpoint.remove` is renamed to `Endpoint.delete`, and its default endpoint name changes from `"remove"` to `"delete"` — the spec-accurate name for a destructive `DELETE /<type>/:id`. (`delete` is a reserved word, so it is re-exported from an internal implementation; `Endpoint.delete(...)` is the public name.)

**Migration:** replace `Endpoint.remove(R, …)` with `Endpoint.delete(R, …)`, and rename the corresponding handler key and client method from `"remove"` to `"delete"`. The to-many relationship-member constructor `Endpoint.removeRelationship` is unchanged — it matches the spec's "removing members" terminology and does not destroy a resource.
