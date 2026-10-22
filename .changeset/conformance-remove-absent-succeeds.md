---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance` adds `spec/relationships/remove-absent-succeeds` and `spec/atomic/remove-absent-succeeds`: a relationship `DELETE`, or an atomic `remove` on a to-many relationship, naming a resource that does not exist must succeed, because that resource is already missing from the relationship (JSON:API 1.1 §Updating To-Many Relationships). A `403` decides nothing; a `404` or any other error is a finding. `Conformance.gaps` no longer lists the relationship removal naming an absent resource.
