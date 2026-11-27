---
"@thomasfosterau/effect-jsonapi": minor
---

Add `ResourceService`: a per-resource contract (`find`, `findMany`, `list`, `create`, `update`, `delete`, `related` and the relationship writes) and `ResourceService.layer`, which implements a whole `Group.resource` or `Group.make` group over it with batched `included` resolution, sparse-fieldset projection, pagination links and the spec statuses. `ResourceService.memory` is an in-memory implementation for tests and examples. Every `Endpoint.*` constructor now annotates its endpoint with the operation it implements. The conformance kit's `top-level-self-matches-document` rule no longer reports a `null` to-one whose `self` link answers `null`.
