---
"@thomasfosterau/effect-jsonapi": minor
---

**`Endpoint.CollectionIncluded` and the `included` type of an `Endpoint.collection` success document no longer admit a member's `paginated` relationship targets (#337).** The runtime schema never accepted them (a `paginated` relationship's target never appears in `included`), so a handler that returned one type-checked and then failed to encode with a 500. The type is now the members' non-`paginated` targets, as `Resource.DefaultIncluded` and `Resource.FamilyDefaultIncluded` already are, with or without `include` and `fields`. With `Article.history = Relationship.paginated(() => Revision)`, `Endpoint.collection([Article, Person], …)`'s `included` element type no longer includes `typeof Revision.Type`.

The change is type-level only and removes only members no compliant response carries. It is a minor release because code that compiled against the released types can stop compiling: a handler returning such a target in `included` is now a compile error (it was a runtime 500), and a `switch` on an `included[].type` with a `case` for a dropped type is now TS2678. Delete that `case`.
