---
"@thomasfosterau/effect-jsonapi": patch
---

Clearer messages when a filter literal does not encode. A non-finite number is now named as written (`Expected a finite number to encode as a filter literal, got NaN`, `… got Infinity`, `… got -Infinity`) instead of as `got null`. A `null` literal in a filter tree (`Filter.eq("age", null)`) now fails with `NULL is not a filter literal for field "age" (use the isnull operator)`, for every filterable field, instead of the literal codec's bare type error (`Expected number`). What is accepted and rejected is unchanged.
