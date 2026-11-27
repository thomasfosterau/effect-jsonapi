---
"@thomasfosterau/effect-jsonapi": patch
---

Ignore @-members (`@context`, `@type`) in request bodies, as JSON:API 1.1 §7.10.2 requires: the closed `attributes` and `relationships` of `createPayload`, `updatePayload` and the atomic `add` / `update` operations accept them and drop them from the decoded value, instead of answering 400. An undeclared ordinary member is still a 400.
