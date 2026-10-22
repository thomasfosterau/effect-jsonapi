---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance` gains three profile-tier rules for the rest of the filter profile's §10 sort order (#427). `profile/sort/multi-field` (MUST, S-MULTI-1) sends `?sort=f₁,f₂` and `?sort=f₁,-f₂` over a tie on `f₁` and holds each answer to lexicographic order. `profile/sort/id-tiebreak` (SHOULD, S-TIE-1/S-TIE-2) holds the resources that tie under `?sort=f` and `?sort=-f` to one fixed order on `id`. `profile/sort/across-pages` (MUST, S-PAGE-1) follows `next` from a sorted first page on endpoints that declare `page[limit]` or `page[size]`, and holds the two pages to one order. Each is read-only, needs no fixture, makes at most 60 requests per run, and skips, naming why, when no endpoint's collection can decide it.
