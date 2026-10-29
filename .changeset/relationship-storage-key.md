---
"@thomasfosterau/effect-jsonapi": minor
---

`Relationship.one` and `Relationship.optional` take a `key` option: the to-one relationship's storage key, which is the field on the declaring resource's stored row that holds the related id (`Relationship.one(() => Person, { key: "authorId" })`) (#509). The key is recorded on the descriptor, typed as the literal you pass, and read back with `Resource.relationships(R).author.key`; it is `undefined` when none is declared. It is a storage fact only: documents, the query grammar and endpoints are unchanged. `Resource.make` and `Resource.extend` refuse, at definition time, an empty key, a key that is also an attribute name, and a key that two to-one relationships share. The key survives `Resource.extend` and `Resource.annotate`.

The lowercase annotation types gain a third parameter for it (`Relationship.one<Person, false, "authorId">`, defaulting to `undefined`), and `Relationship.One` / `Optional` gain one too (defaulting to the new `Relationship.StorageKey`). Downstream derivations, such as legation's `NodeBridge` (legation#220), can read the key from the descriptor instead of guessing `${name}Id`; they should raise their `effect-jsonapi` floor to the release this ships in.

A type-level test that pins a constructed descriptor with exact equality against the uppercase model types now names the key as well, because the uppercase defaults are wide (as `F`'s already was): `Relationship.One<typeof Person, true, undefined>` rather than `Relationship.One<typeof Person, true>`. Assignability to `Relationship.One<R>`, `ToOne<R>` and `Descriptor` is unchanged.
