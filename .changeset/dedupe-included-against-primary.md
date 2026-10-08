---
"@thomasfosterau/effect-jsonapi": patch
---

`Handlers.data`, `Handlers.collection`, `Handlers.buildIncluded` and the `Assemble` builders that route through them no longer emit a resource in `included` when it is already present as primary data. A compound document now carries one resource object per `(type, id)` pair, as JSON:API requires — previously a heterogeneous collection whose include target was also one of the hits (e.g. `/search?include=author`) repeated that resource in `included`. When every `included` candidate is already primary data, the `included` member is omitted, as it is when none is passed.
