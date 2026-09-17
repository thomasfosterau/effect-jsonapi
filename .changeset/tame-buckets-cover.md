---
"@thomasfosterau/effect-jsonapi": minor
---

**`Query.bracketKeys`: the general form of `Query.bracketPageKeys`.** Re-keys an arbitrary set of a
flat query struct's encoded keys under an arbitrary bracket prefix — `page`, `filter`, `fields`, or
one of your own — not just `offset` / `limit` under `page`. Composes when piped more than once onto
the same struct, so a consumer-owned flat query struct can bracket several families at once without
losing any of them (#111).

```ts
const ListArticles = Schema.Struct({
  ...Query.Page.offset({ maxLimit: 100, fromString: false }),
  authorId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String)
})

const wire = ListArticles.pipe(Query.bracketKeys("page", ["offset", "limit"]), Query.bracketKeys("filter", ["status"]))
// wire:    { "page[offset]": …, "page[limit]": …, "filter[status]": …, authorId: … }
// decoded: { offset, limit, status, authorId }   ← unchanged, still flat
```

`Query.bracketPageKeys` is unchanged and now built on top of `bracketKeys` —
`Query.bracketPageKeys(s)` is exactly `s.pipe(Query.bracketKeys("page", ["offset", "limit"]))`.
