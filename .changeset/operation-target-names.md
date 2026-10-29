---
"@thomasfosterau/effect-jsonapi": minor
---

**Deprecated:** `Atomic.ResourceOperationShape` and `Atomic.RelationshipOperationShape` are renamed `Atomic.ResourceOperationTarget` and `Atomic.RelationshipOperationTarget` (#436). The old names remain as deprecated aliases for one minor release.

**Migration:** replace `Atomic.ResourceOperationShape<R>` with `Atomic.ResourceOperationTarget<R>`, and `Atomic.RelationshipOperationShape<R, K>` with `Atomic.RelationshipOperationTarget<R, K>`. The types are identical.
