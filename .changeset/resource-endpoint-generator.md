---
"@thomasfosterau/effect-jsonapi": minor
---

**Whole-resource endpoint generation:** `Endpoint.resource` and `Group.resource` derive an entire JSON:API endpoint set from a single resource definition — the full CRUD surface plus, for every relationship, the `related` and linkage endpoints appropriate to its kind — with `include` / `fields` / `sort` query parameters derived from the resource graph.

```ts
// The whole group, fully typed, in one call:
const articles = Group.resource(Article, {
  errors: [ArticleNotFound],
  page: Query.Page.Offset,
  // per-endpoint config overrides the top-level defaults:
  endpoints: {
    create: { errors: [TitleTaken] },
    list: { filter: { author: Schema.optionalKey(Schema.String) } }
  }
})

// Or get the endpoints as a tuple to compose with Group.make:
const articles = Group.make(
  Article,
  ...Endpoint.resource(Article, { errors: [ArticleNotFound] }),
  Endpoint.list(Article, { name: "search", path: "/articles/search", filter: { q: Schema.String } })
)
```

Defaults emit all five CRUD operations and every relationship's endpoints with `include` / `fields` / `sort` enabled; `page` and `filter` stay opt-in, and `errors` is applied uniformly. Everything is overridable, globally or per entry:

- `endpoints` is an object keyed by operation (`get` / `list` / `create` / `update` / `delete`); each value is `true` (emit with defaults), `false` (omit), or an object configuring that endpoint (its `name` / `path` / `errors` and applicable query / `meta`), overriding the top-level defaults.
- `relationships` is `true` (all, default) / `false` (none), or an object keyed by relationship name — each `false` to exclude, or an object to configure that relationship's endpoints. Relationships not mentioned are emitted with the defaults.
- `meta` may be a `Schema` (overriding the document meta) or a function `(base) => schema` that _extends_ the resource's base meta rather than replacing it.

The result is plain `HttpApiEndpoint` / `HttpApiGroup` values, so it composes with everything as before. See `Endpoint.ResourceOptions`.

**Breaking:** several endpoint constructors are renamed, and the heterogeneous-collection constructor now takes an explicit route.

- `Endpoint.fetch` → `Endpoint.get` (default endpoint name `"fetch"` → `"get"`).
- `Endpoint.remove` → `Endpoint.delete` (default endpoint name `"remove"` → `"delete"`). `delete` is a reserved word, so it is re-exported from an internal implementation; `Endpoint.delete(...)` is the public name.
- `Endpoint.fetchRelationship` → `Endpoint.getRelationship` (the relationship-linkage GET, for parity with `Endpoint.get`). The generated endpoint name `<name>Relationship` is unchanged, so handler keys and client methods are unaffected.
- `Endpoint.search` → `Endpoint.collection`, and its `name` and `path` are now **required** (the `"search"` / `/search` defaults are removed). A polymorphic collection has no owning resource and so no conventional route; the constructor name no longer presumes "search" (it fits feeds and timelines just as well). The exported `SearchIncluded` type is renamed to `CollectionIncluded`.

**Migration:** replace `Endpoint.fetch(R, …)` / `Endpoint.remove(R, …)` with `Endpoint.get(R, …)` / `Endpoint.delete(R, …)`, and rename the corresponding handler keys and client methods (`"fetch"` → `"get"`, `"remove"` → `"delete"`). Replace `Endpoint.fetchRelationship(R, …)` with `Endpoint.getRelationship(R, …)` — a rename of the constructor only; its `<name>Relationship` endpoint name (and thus its handler key) is unchanged. Replace `Endpoint.search([…], { … })` with `Endpoint.collection([…], { name: "search", path: "/search", … })` (the explicit `name` / `path` reproduce the old defaults), and rename any `SearchIncluded` references to `CollectionIncluded`. `Endpoint.removeRelationship` is unchanged — it matches the spec's "removing members" terminology and operates on relationship linkage, not whole resources.
