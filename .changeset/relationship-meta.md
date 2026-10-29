---
"@thomasfosterau/effect-jsonapi": minor
---

A relationship object's `meta` can be typed (#513).

- **Per relationship (the source of truth).** `Relationship.one`, `optional`, `many` and `paginated` take a `meta` schema (`Relationship.many(() => Ballot, { meta: Schema.Struct({ totalCount: Schema.Number }) })`). It types the relationship object's `meta` in the resource schema, and so in its documents, `Document.wire`, `Endpoint.ResourceDocument` / `FlatCollectionDocument` / `WriteDocument`, `Group.flat` / `flatReadOnly`, the endpoints' OpenAPI and the typed client. The descriptor records the schema as `meta` (`Document.AnyMeta`, the old open record, when none is declared), and `Relationship.MetaOf<D>` reads it. What `Assemble` and `ResourceHandlers` build over the resource's own type then fits those documents without a cast.
- **Per call (an override).** `Document.wire(schema, { toManyMeta })`, the flat document helpers' `toManyMeta` option, and `Group.flat` / `flatReadOnly({ …, toManyMeta })` narrow **every** to-many relationship's `meta` (`many` and `paginated`, in the primary data and `included`) at the call site. To-one relationships keep their own. `Document.WithToManyMeta<T, Meta>` is the type-level counterpart.

The model types gain a type parameter for the schema: `Relationship.One` / `Optional` take it fourth, `Many` second and `Paginated` third. On the uppercase types it defaults to the wide `Schema.Top`. On the lowercase annotation types (`Relationship.one<…>`, `many<R, M>`, …) it defaults to `typeof Document.AnyMeta`, as the constructors do. `Relationship.OneSchema` / `OptionalSchema` / `ManySchema` / `PaginatedSchema` take the meta schema too, defaulting to `typeof Document.AnyMeta`.

**Migration:** a type-level test that pins a constructed descriptor with exact equality against an uppercase model type (`Relationship.One<typeof Person, true, undefined>`) should name the lowercase annotation type instead (`Relationship.one<typeof Person, true>`), which carries the constructor's defaults. Assignability is unchanged.
