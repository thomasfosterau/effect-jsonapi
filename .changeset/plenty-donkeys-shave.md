---
"@thomasfosterau/effect-jsonapi": minor
---

Resource metadata and introspection, so a third party can derive from a resource definition without
reverse-engineering it.

**`Resource.annotate` / `Resource.annotations`.** A resource definition is a `Schema.Struct` with its
derived members assigned onto it, so Effect's own `resource.annotate({ ... })` rebuilt the schema and
returned a plain struct with `type`, `identifier`, `relationships`, `declaredAttributes`,
`createPayload`, `document()` and the rest gone — it was no longer a resource, and no longer a valid
relationship target. `Resource.annotate(resource, annotations)` is the supported seam: it returns a
complete resource of the same type, valid as a `Relationship.one(() => …)` target, with the
annotations readable through `Resource.annotations(resource)`. Annotations are inherited by
`Resource.extend` (the child's own keys winning) and can be declared up front with the new
`annotations` option of `Resource.make` and `Resource.extend`.

**`Resource.attributeDescriptors`.** The per-attribute shape a resource declares, in declaration
order, as plain data: `key`, `schema`, presence in the resource object and both write projections,
`clearable`, `nullable`, `readOnly` and the attribute's annotation bag. Consumers no longer need
`resource.fields.attributes.ast`, a cast through `unknown`, or a decoder run against sentinel values
to learn what the declaration already said.

**`Relationship.paginated(ref, { order })`.** A paginated relationship can now declare its canonical
order — a list of `Sort.Term`s over the related resource's attributes or its `id`. Paging is only
well defined over a stable total order (`first` / `prev` / `next` / `last` denote a sequence of
pages, and a cursor is a position in an order), so this is part of the relationship's wire contract
rather than a storage detail, and it gets a first-class slot instead of an annotation. Storage
vocabulary — a foreign-key column, a table name — has no wire representation and stays an annotation.

Also: `Sort.Term` is now public (the `{ field, direction }` shape `Query.Sort` decodes into), and
`Resource.Any` declares `declaredAttributes`, so `Resource.declaredAttributes` no longer reads it
through a cast.
