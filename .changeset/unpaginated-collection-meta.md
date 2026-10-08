---
"@thomasfosterau/effect-jsonapi": minor
---

`Assemble.unpaginatedCollection` takes an optional `meta`, the document's top-level metadata (a generation timestamp, a cache hint, an application-specific summary), and emits it as given. Without `meta` the output is unchanged, with no `meta` member. `Assemble.UnpaginatedCollectionOptions` and `Assemble.UnpaginatedCollectionDocument` gain a third type parameter, the type of the `meta` passed: no `meta` member when none was passed (the default), `meta` of that type when it was, and `meta` optional when the type admits `undefined`, so a caller can forward its own optional `meta` as is. `meta.totalCount` is not special-cased. A collection whose total matters goes through `Assemble.collection`.
