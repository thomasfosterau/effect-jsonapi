---
"@thomasfosterau/effect-jsonapi": minor
---

`ApiError.make` can declare a `source` (constant, or a function of the fields for a per-instance
`pointer`/`parameter`/`header`), so field-scoped validation errors like "this slug is taken" can
carry `source.pointer` without hand-building a document. Added `Document.pointer` (RFC 6901
constructors for attribute/relationship pointers, with a collection-payload `index` and an
`escape` helper) and `Document.parsePointer` (the inverse: parses a pointer back to the member it
names, `None` for non-member and empty-segment pointers). `Middleware`'s internal JSON Pointer
builder now reuses `Document.pointer.escape` instead of its own copy of the RFC 6901 escaping.
