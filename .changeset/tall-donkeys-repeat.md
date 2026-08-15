---
"@thomasfosterau/effect-jsonapi": minor
---

**`success` override on `Endpoint.delete`.** The constructor bound its response unconditionally to
`HttpApiSchema.NoContent`, so every generated delete was a 204 with an empty body. It now takes an
optional `success` schema (and a `status` for the rare non-200 case), defaulting to that 204, for
apis whose deletion answers with a body — a soft delete that marks the row deleted, re-reads it and
returns the tombstone resource document. The override is served as `application/vnd.api+json` like
every other body in the package. The option is threaded through `Endpoint.resource` /
`Group.resource`'s per-endpoint `delete` config, so a generated group can adopt tombstone deletes
without being spelled out by hand. Only the response changes — path, params, errors and middleware
are untouched.
