---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance`: `spec/links/relationship-self-dereferences` now holds a links-only relationship's `self` link (every `Relationship.paginated`) to the cardinality the relationship endpoint it resolves to declares. Discovery reads it off each `Endpoint.getRelationship` success schema — to-one when `data` encodes as an identifier or `null`, to-many when it encodes as an array — so a paginated to-many relationship whose relationship endpoint answers a single identifier now fails the rule, with the finding naming the declaring endpoint. A link to no declared relationship endpoint, or to one whose success schema shows no cardinality, still takes linkage of either kind.
