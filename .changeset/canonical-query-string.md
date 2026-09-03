---
"@thomasfosterau/effect-jsonapi": minor
---

**The canonical query string: `Query.canonical(schema)`, with the pagination link builders and
`Handlers.collection` carrying the request's full query.** JSON:API 1.1 requires a collection
document's `self` link to carry the query parameters the client provided; a decoded query now has
exactly one wire spelling, produced by one function with one ordering rule.

```ts
const listQuery = Query.schema(Article, {
  include: true,
  fields: true,
  sort: true,
  page: Query.Page.Offset,
  filter: true
})
const canonical = Query.canonical(listQuery)

canonical(query)
// → "include=author&fields[articles]=title&filter[status]=open&sort=-createdAt&page[offset]=0&page[limit]=10"
```

- **One order.** `include`; `fields[*]` sorted by type; `filter[*]` in the filter grammar's
  canonical order (shorthand sorted by key, the group form in the encoder's pre-order); `sort`;
  `page[*]` in the page strategy's declared order (`offset, limit` — what the link builders already
  emit); then any other key sorted. Two equal decoded queries produce byte-identical strings whatever
  spelling they came from (key order, `?include=a&include=b` against `?include=a,b`,
  `filter[f][eq]=v` against `filter[f]=v`), and the string decodes back to the same query.
- **One encoding.** `Query.serialise(pairs)`: RFC 3986 percent-encoding via `encodeURIComponent`
  (spaces `%20`, commas `%2C` — a list's separator and the grammar's `\,` alike), `[` / `]` left
  readable in keys, pairs joined with `&`. `URLSearchParams` / `UrlParams` decode it back
  identically. `Query.canonicalPairs(schema)` is the ordered pair list before serialisation.
- **Link builders.** `Handlers.offsetPaginationLinks` / `numberPaginationLinks` now serialise
  through `Query.serialise` (their output is unchanged) and take an optional fourth argument
  `{ query: Query.canonicalPairs(listQuery)(query) }` — the request's other canonical pairs, into
  which each page cursor is slotted — so `self` / `first` / `prev` / `next` / `last` carry the
  full `include` / `fields` / `filter` / `sort`.
- **`Handlers.collection`** takes a `query` option (the canonical pairs or string) appended to its
  `self` link, for collections that are not paginated.
