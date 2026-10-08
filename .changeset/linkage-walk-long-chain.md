---
"@thomasfosterau/effect-jsonapi": patch
---

The full-linkage check's new reachability walk (`Handlers.data`, `Handlers.collection`, `Handlers.buildIncluded`) loops over its levels instead of recursing once per level, so a valid document whose `included` members form a long chain of resource linkage, thousands of members deep, no longer throws `RangeError: Maximum call stack size exceeded`.
