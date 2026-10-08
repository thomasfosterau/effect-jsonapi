---
"@thomasfosterau/effect-jsonapi": patch
---

**Security:** fixes a prototype-pollution vulnerability (CWE-1321) reachable through query parameters on endpoints whose query declares no family (e.g. `Endpoint.get` of a resource without relationships), and a request-triggerable 500 in the filter grammar for field names that collide with `Object.prototype` members. Versions 0.1.0–0.16.3 are affected; upgrade.

An endpoint whose query declares no family — `Endpoint.get(R)` for a resource with no relationships, or any `Query.schema(R, {})` — no longer passes undeclared query parameters through to the handler's `query` (typed `{}`). `Query.schema` now keeps only the keys it declares, whether or not it declares any, so such a query decodes (and encodes) to `{}` exactly as undeclared keys are already dropped by a query that declares something. That includes a name admitted by `Middleware.layerWith({ allowedQueryParameters })`, which now never reaches the decoded `query`, as documented. The bracket reshaper behind it writes every key as an own property and no longer throws on a bracket key whose name a bare key also holds. The `filter: true` grammar (and `Filter.normalise`) reads only a resource's own filterable fields, so any field name it does not declare is a 400 `Unknown filter field` on decode and an `InvalidFilter` on encode. Declared parameters decode and encode as before.
