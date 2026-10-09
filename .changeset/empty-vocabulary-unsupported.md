---
"@thomasfosterau/effect-jsonapi": patch
---

**Behaviour change: an `include` or `sort` family declared with an empty vocabulary now counts as unsupported, so a request that used to succeed can now answer 400.** This covers `include: { paths: [] }`, `include: true` on a resource with no relationships, and `sort: true` on a resource with no attributes. The `SchemaErrors` middleware now answers any `?include=` or `?sort=` on such an endpoint exactly as it answers one on an endpoint that never declared the family: a 400 naming the parameter in `source.parameter`, with the detail saying the endpoint does not support it. That includes an empty value (`?include=`, `?sort=`), which used to answer 200, and a bracketed member such as `include[x]`, which used to be ignored. A non-empty value used to answer 400 with the detail `Expected never` and `meta.includablePaths: []` / `meta.sortableFields: []`. It now gets that same unsupported-parameter 400, without the `meta` (#282).

Where such a value still reaches the codec, its rejection now says why: an `allowedQueryParameters` entry that admits the family, or a direct decode with `Query.Include`, `Query.Sort` or `Query.schema`. The detail is `This endpoint supports no include paths.` or `This endpoint supports no sortable fields.` in place of `Expected never`.
