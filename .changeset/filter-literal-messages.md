---
"@thomasfosterau/effect-jsonapi": patch
---

Clearer messages when a filter literal does not encode. A non-finite number is now named as written (`Expected a finite number to encode as a filter literal, got NaN`, `… got Infinity`, `… got -Infinity`) instead of as `got null`. A `null` literal in a filter tree (`Filter.eq("age", null)`) now fails with `NULL is not a filter literal for field "age" (use the isnull operator)`, for every filterable field, instead of the literal codec's bare type error (`Expected number`).

One behaviour change: the NULL check runs on every literal, on decode as well as encode, so it also covers an explicit literal codec (`filterLiteral`, or `Filter.able(…, { literal })`) that decodes a wire string to `null`. Such a codec — say one mapping `"none"` to `null` — used to yield `Compare(eq, field, null)` or an `In` list holding `null`; that filter is now a 400 with the message above, and a tree holding the `null` no longer encodes or passes `Filter.normalise`. NULL is never a filter literal (`docs/filter-grammar.md` F-NULL-1): use `isnull`. Derived literal codecs never produce `null`, so nothing else that decoded or encoded before is affected.
