---
"@thomasfosterau/effect-jsonapi": patch
---

`ServerErrors.schemaIssueToErrors` now walks a schema issue with `@thomasfosterau/effect-ext`'s `Issues.leaves` / `Issues.message` instead of a local copy (#555). The error objects it renders are unchanged: a struct-level check's message for the fields it points at, with no appended path. The effect-ext dependency floor moves to `^0.2.0`, the release that carries that walk.
