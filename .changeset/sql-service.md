---
"@thomasfosterau/effect-jsonapi": minor
---

Add the `@thomasfosterau/effect-jsonapi/SqlService` subpath: `SqlService.make` builds a complete `ResourceService` over any `effect/sql` driver, with attribute and to-one columns, join tables for to-many relationships, batched loads, equality and `Filter` grammar `WHERE` clauses, sorting, offset and number pages, and transactional writes. Add `ResourceService.Complete`, a service with every member, which `ResourceService.memory` now answers; `ResourceService.includeTarget` takes any value with a `find` (and optional `findMany`).
