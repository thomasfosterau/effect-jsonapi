---
"@thomasfosterau/effect-jsonapi": patch
---

A name-only `Resource.family`'s synthesised `relationships` are now typed as the by-key intersection the runtime computes (the new `Resource.FamilyRelationships`), instead of the open `Relationships` record. So `Query.schema(Media, { fields: true })` over a name-only family, and `Endpoint.related(G, "items", { fields: true })` to one, declare exactly the member types' `fields[TYPE]` keys in their types, matching the runtime, rather than any `string` key: a misspelt `fields.phtos` no longer compiles (#363). A shared to-one relationship is typed `filter: false`, as nothing is filterable through a name-only family.
