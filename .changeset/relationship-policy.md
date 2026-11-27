---
"@thomasfosterau/effect-jsonapi": minor
---

Add `Relationship.toOne` and `Relationship.toMany`, which declare a relationship's linkage policy separately from its cardinality: `linkage` (`"always"`, `"whenIncluded"`, `"optional"` or `"never"`), `includable`, `writable` and, on a to-many, `paginationLinks`. `one`, `optional`, `many` and `paginated` are presets over them and keep their types and behaviour. The resource schema, include paths, create and update payloads, atomic operations and client read the policy, so linkage only when included, a links-only to-one, an includable or settable large to-many, and a to-many whose `data` is paged by `links.next` can now be declared, served and decoded. Every descriptor now carries `linkage`, `includable`, `writable` and `paginationLinks`; `Relationship.isLinkable` returns a plain `boolean`, and `Document.RelationshipPaginationLinks` is new.
