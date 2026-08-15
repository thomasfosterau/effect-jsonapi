---
"@thomasfosterau/effect-jsonapi": minor
---

**`query` override on `Endpoint.list`.** The constructor composed its query schema from the
`include` / `fields` / `sort` / `page` / `filter` options and offered no way out of that composition,
which always nests what it decodes (`page: { offset, limit }`, `filter: { … }`). It now takes an
optional `query` schema — any `Schema.Top` — defaulting to that composition, for apis whose list
contract is a flat struct their own operations layer consumes: a page cursor bracket-keyed on the
wire but decoded flat (see `Query.bracketPageKeys`), entity foreign keys, and flags JSON:API has no
query family for, which `filter` would otherwise put on the wire as `filter[<name>]`. The feature
options are ignored once `query` is given. The option is threaded through `Endpoint.resource` /
`Group.resource`'s per-endpoint `list` config. Only the query changes — path, success document,
errors and middleware are untouched.
