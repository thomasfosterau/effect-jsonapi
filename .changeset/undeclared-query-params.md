---
"@thomasfosterau/effect-jsonapi": patch
---

An endpoint whose query declares no family — `Endpoint.get(R)` for a resource with no relationships, or any `Query.schema(R, {})` — no longer passes undeclared query parameters through to the handler's `query` (typed `{}`), and a colliding pair of them (`?x=1&x[y]=2`) is no longer a 500. `Query.schema` now keeps only the keys it declares, whether or not it declares any, so such a query decodes (and encodes) to `{}` exactly as undeclared keys are already dropped by a query that declares something. That includes a name admitted by `Middleware.layerWith({ allowedQueryParameters })`, which now never reaches the decoded `query`, as documented. The bracket reshaper behind it is also total: a bracket key whose name a bare key holds stays under its own spelling instead of throwing, and every key is written as an own property, so `__proto__` is an ordinary name. Declared parameters decode and encode as before.
