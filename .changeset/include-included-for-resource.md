---
"@thomasfosterau/effect-jsonapi": minor
---

`Include.included` also takes a resource and an endpoint's `include` option, and returns the `included` union that endpoint's default document binds (#342): `Include.included(Article, { include: true })` is the `Schema.Union` over `Article`'s non-`paginated` direct targets and every resource a legal include path reaches, exactly what `Endpoint.get` / `list` over `Article` with `include: true` admit. A `Query.IncludeOptions` (`depth`, `paths`) bounds the walk as it bounds the endpoint's paths, `include: false` gives the direct targets, and a declared `Include.Surface` gives the surface's own `included`. Pass a `related` endpoint's target for its union, and the array of a `collection` endpoint's resources (or `family.members` for `polymorphic`) with a boolean or `Query.IncludeOptions` for theirs.

An endpoint that overrides `success` with a wire variant can now declare `Document.DataDocument(WireArticle, { included: Include.included(Article, { include: true }) })` instead of listing every reachable type by hand, a list that drifted from the paths the endpoint advertises and failed to encode (500) on the path that reached a missing type. The result is typed as the new `Include.Reachable<R, I>`. Like the rest of `Include`, the helper is also exported from the schema-only entry point (`@thomasfosterau/effect-jsonapi/schema`), which still resolves `effect` alone.

`Include.included(spec)` is unchanged.
