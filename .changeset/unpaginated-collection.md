---
"@thomasfosterau/effect-jsonapi": minor
---

Add `Assemble.unpaginatedCollection(resources, options?)` and its `Assemble.UnpaginatedCollectionDocument` type, for a collection served whole — a small fixed list, or a to-many related collection that is never paged. It shares `Assemble.collection`'s capability stamping, sparse-fieldset projection, link coercion, batched `include` walk, pre-resolved `included` handling and `jsonapi` member, but emits no top-level `links` and no `meta`, so the document no longer advertises `meta.totalCount` or `first` / `last` / `prev` / `next` links the endpoint doesn't honour; the return type has neither member. `Assemble.collection`'s call shape, output and type are unchanged.
