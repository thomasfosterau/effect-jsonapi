---
"@thomasfosterau/effect-jsonapi": patch
---

Tested against `effect` 4.0.0; the peer floor (`>=4.0.0-rc.118`) is unchanged. `Resource.Id` and `Resource.extend`'s `inheritId` now pass an explicit type argument to `Schema.brand`, which 4.0.0 requires of a generic brand identifier. The public types are identical.

On effect 4.0.0, `Schema.brand` is type-only, so `Id` schemas no longer carry an `ast.annotations.brands` entry and `SchemaRepresentation` code output omits the brand; OpenAPI and JSON Schema output are unchanged.
