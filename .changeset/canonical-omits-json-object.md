---
"@thomasfosterau/effect-jsonapi": patch
---

`Query.canonical` / `Query.canonicalPairs` (and so the `self` and pagination links built from them) omit a flat query member whose encoded value is a JSON object, as they already omit `null` (#536). A JSON object has no flat wire form; before, it was written as `key=[object Object]`.
