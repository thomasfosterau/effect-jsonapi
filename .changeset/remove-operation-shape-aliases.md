---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** the deprecated aliases `Atomic.ResourceOperationShape` and `Atomic.RelationshipOperationShape` are removed (#525). They were renamed in 0.20.0 and kept as deprecated aliases for one minor release.

**Migration:** replace `Atomic.ResourceOperationShape<R>` with `Atomic.ResourceOperationTarget<R>`, and `Atomic.RelationshipOperationShape<R, K>` with `Atomic.RelationshipOperationTarget<R, K>`. The types are identical.
