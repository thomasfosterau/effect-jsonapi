---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance` checks the rest of the profile's sort order (`docs/filter-grammar.md` §10) with three new profile rules: `profile/sort/multi-field` (S-MULTI-1: `?sort=a,-b` and `?sort=-a,b` order lexicographically, each term in its own direction), `profile/sort/id-tiebreak` (S-TIE-1, a SHOULD: resources that tie on `f` are listed in the same relative order under `?sort=f` and `?sort=-f`) and `profile/sort/across-pages` (S-PAGE-1: walking `next` through `?sort=f`, every resource on a page follows every resource on the page before it). Each is read-only and fixture-free, like `profile/sort/ordering`.
