---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance`: `profile/filter/spelling-equivalence` spells its filters on the first string attribute a resource carries rather than skipping when the first attribute is not a string, and escapes the literal per the grammar's §2.3. `profile/filter/evaluation` now also probes the §6.5 corollaries F-CONS-2 to F-CONS-7 — De Morgan both ways, `Not(In)`, double negation, one canonical form in a second spelling, `included` beside a filter, and a filtered response's shape (each answered resource as served unfiltered, an empty result a 200 collection document) — and the coverage gap no longer lists them as unprobed (#458).
