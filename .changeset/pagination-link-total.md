---
"@thomasfosterau/effect-jsonapi": minor
---

`Assemble.Pagination` gains `linkTotal` and `lastUnknown`, and `Assemble.edgePage`'s `input` forwards both. `linkTotal` is the total the pagination links (`last`, and whether `next` exists) are computed from, defaulting to `totalCount`; `meta.totalCount` stays `totalCount`. `lastUnknown: true` omits `links.last` (the key is absent, not `null`) while `self` / `first` / `prev` / `next` stay exact. A search with no corpus count passes `linkTotal = offset + page.length + (hasMore ? 1 : 0)` and `lastUnknown: true`. Additive; no published type changes (`LinksValue.last` was already optional). From gardeneria#1263 O8 (#569).
