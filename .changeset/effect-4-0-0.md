---
"@thomasfosterau/effect-jsonapi": patch
---

Tested against `effect` 4.0.0; the peer floor (`>=4.0.0-rc.118`) is unchanged. `Resource.Id` and `Resource.extend`'s `inheritId` now pass an explicit type argument to `Schema.brand`, which 4.0.0 requires of a generic brand identifier. The public types are identical.
