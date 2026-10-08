---
"@thomasfosterau/effect-jsonapi": patch
---

Presence of `include` now decides the `included` key everywhere. A bare `?include=` decodes to `[]`; `Assemble.resource` / `Assemble.collection` / `Assemble.unpaginatedCollection` used to treat that as no `include` and omit the key, and now answer it with `included: []`, as does `Handlers.resolveIncluded`, which returns `[]` for an empty path list instead of `undefined`. `ResourceHandlers.related` answers a to-one with empty linkage `{ data: null, included: [] }` when the request carried `include`, and validates those paths first, so an unsupported path is a `400` there as it is for a resolved to-one (it used to answer `200` with no `included`). `Handlers.DocumentValue` now always declares an optional `included`, so `Handlers.data(r, { included: [] }).included` type-checks.
