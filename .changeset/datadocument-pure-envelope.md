---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** `Document.DataDocument` is now a pure envelope — its `data` member is exactly the schema you pass, dropping the implicit `Schema.NullOr`. `DataDocument(R)` changes from `data: R | null` to `data: R`.

JSON:API only permits `null` primary data for a single-resource request whose URL might correspond to a resource but currently doesn't ([§Fetching Resources → 200 OK](https://jsonapi.org/format/1.1/#fetching-resources-responses-200)). Fetch-existing / create (201) / update (200) always carry the resource — a missing one is a `404`, never `200 { data: null }` — so nullability is now the caller's compositional decision rather than something the constructor bakes in:

```ts
DataDocument(Article) //                  data: Article            (was: Article | null)
DataDocument(Schema.NullOr(Article)) //   data: Article | null
DataDocument(Article.nullable()) //       data: Option<Article>, ⇆ null on the wire
```

**Migration:** restore the old shape by wrapping the argument — `DataDocument(Schema.NullOr(R))`. Downstream this lets consumers delete hand-rolled non-null single-resource envelopes (e.g. a website's `ResourceDocument` becomes `Document.DataDocument(wireResource(resource))`).

Ripple effects:

- `Resource.document()` and `Endpoint.fetch` / `Endpoint.create` / `Endpoint.update` now produce non-null primary `data` (the canonical single-resource document for an existing resource).
- `Endpoint.related` for a to-one relationship keeps the nullable form (`data: target | null`) to preserve the empty-linkage `data: null` case.
- New `Resource.nullable()` method on every resource definition — `Article.nullable()` is `Schema.OptionFromNullOr(Article)`, the blessed, spec-clean nullable codec (`None ⇆ null`) for `Document.DataDocument(Article.nullable())`. Prefer it over effect's structural `Schema.Option` (`{ _tag, value }`), which would serialise a non-conformant body.
