---
"@thomasfosterau/effect-jsonapi": minor
---

`Assemble.unpaginatedCollection` takes an optional `self` — the collection's absolute URL — and `query`, the request's canonical pairs (`Query.canonicalPairs(listQuery)(query)`). With `self`, the document carries `links: { self }`, with `query` appended and serialised the way `Assemble.collection`'s pagination links carry it; without `self` the document has no `links` member. The options are the new `Assemble.UnpaginatedCollectionOptions`, and `Assemble.UnpaginatedCollectionDocument` gains a second type parameter, the type of the `self` passed: no `links` member when none was passed (the default), `links.self` required for a `string`, and `links` optional for a `string | undefined`. `query` without `self` is a type error, and a `self` that is `undefined` at runtime drops the `query` along with the link. A `self` link is not page math: it adds no `meta`.
