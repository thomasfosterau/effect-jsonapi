---
"@thomasfosterau/effect-jsonapi": patch
---

The default success document of a read endpoint whose `include` option is `true` or a `Query.IncludeOptions` now admits in `included` every resource its legal include paths reach, beside the non-`paginated` direct targets it admitted before (#320). Under `include: true`, `Endpoint.get(Article, { include: true })` advertises `comments.author`, and its document now carries the `people` that path brings in: a handler returning them type-checks, and `GET /articles/1?include=comments.author` answers 200 where it failed to encode and answered 500. The walk is bounded as the paths are: two hops under `include: true`, the `depth` an option names, or the exact `paths` of an allow-list. The same holds for `Endpoint.list`, `related` (over the target's graph), `collection` and `polymorphic` (over every member's graph), and the `get` / `list` / related endpoints `Endpoint.resource` and `Group.resource` derive.

An endpoint with `include` off, or with a declared `Include.Surface`, keeps exactly the document it had, on the wire and in its type.

The widened union is visible to clients too, since it is what `HttpApiClient` decodes `included` into and what the OpenAPI output describes: an exhaustive `switch` on `included[].type` and a client regenerated from the OpenAPI document both see the new member types, and `Group.resource` turns this on for its derived `get`, `list` and related endpoints by default, since it defaults to `include: true`.
