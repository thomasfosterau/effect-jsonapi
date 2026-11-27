---
"@thomasfosterau/effect-jsonapi": minor
---

Let `query`, `success` and `payload` overrides on `Endpoint.get`, `list`, `create` and `update` extend the derived default instead of replacing it: pass a function of the default (`query: (derived) => Query.extend(derived, { includeDeleted })`, `success: (derived) => Document.extend(derived, { meta })`). `Query.extend` and the new `Query.schema` option `parameters` declare implementation-specific parameters on both sides of the flat / nested transformation; `Document.extend` sets a document's top-level `meta` / `links` and keeps its `included` union. A plain schema still replaces the default whole.
