---
"@thomasfosterau/effect-jsonapi": minor
---

`Handlers.relationshipLink`, `Handlers.relatedLink` and `Handlers.paginatedRelationship` percent-encode each path segment, so an id carrying `/`, `?`, `#`, `%` or a space produces a link the server can serve (JSON:API 1.1 §7.6, §8). Each takes a `base` option (`{ base: "/api/v1" }`) for an api mounted under a prefix, and `paginatedRelationship` takes a `related` option, like `self`, for a related endpoint served at another path.
