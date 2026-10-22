---
"@thomasfosterau/effect-jsonapi": minor
---

`?sort=` now has specified semantics (#167): `docs/filter-grammar.md` §10, a new section of the filter-grammar profile with stable rule ids (`S-SCOPE-*`, `S-KEY-*`, `S-ORD-*`, `S-MULTI-*`, `S-TIE-*`, `S-PAGE-*`). It reuses §6.2's comparison domain (F-ORD-1: a field's JSON value, code-point order for strings, no locale collation), puts NULLs (an absent attribute or `null`) last ascending and first descending, orders several fields lexicographically, and recommends (SHOULD) breaking remaining ties by `id`. It applies to every list and to-many related endpoint that supports `sort`. The profile URI stays `…/filter-grammar/v1`.

`Conformance` gains a profile-tier rule, `profile/sort/ordering` (MUST), that checks it from the wire with no fixture. For each list or related endpoint declaring `sort`, it fetches the collection, picks the attributes whose values there can show an order (NULL-holding ones first), and holds `?sort=f` and `?sort=-f` to ascending and descending order, NULL placement included. An attribute the server refuses with a 400 is passed over. A collection that cannot show an order (fewer than two distinct values, or values of more than one JSON type) is `Skipped`, never passed. A pass notes when NULL placement went unobserved. At most 60 requests per run. `Conformance.gaps` no longer lists "Sort ordering correctness".
