---
"@thomasfosterau/effect-jsonapi": patch
---

`Conformance.verify` reads an endpoint's `Idempotency-Key` as required when its headers schema is a union every member of which (read through a suspended schema) requires the header, and sends such an endpoint a fresh key on each write, so its write rules run instead of being left not decided by the missing-key 400 (#393).
