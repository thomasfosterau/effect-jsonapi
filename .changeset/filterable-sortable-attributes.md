---
"@thomasfosterau/effect-jsonapi": minor
---

**Per-attribute `filter` / `sort` declarations, with `Resource.filterable` and `Resource.sortable`.**
Filterability is now declared on the resource, per attribute, rather than left to an open per-endpoint
`filter: { key: Schema }` map: `Resource.attribute(schema, { filter, sort })` records which operators an
attribute admits and whether it may be sorted on, and the declaration rides on the attribute's schema
alongside the existing create/update descriptor, so it is carried through `Resource.extend` and
`resource: "optional"`.

```ts
const Product = Resource.make("products", {
  attributes: {
    name: Schema.NonEmptyString, // neither filterable nor sortable
    priceCents: Resource.attribute(Schema.Int, { filter: ["eq", "gt", "lt"], sort: true }),
    discontinued: Resource.attribute(Schema.Boolean, { filter: true })
  }
})

Resource.filterable(Product) // { priceCents: { operators, literal }, discontinued: { … } }
Resource.sortable(Product) // ["priceCents"]
Endpoint.list(Product, { sort: Resource.sortable(Product) })
```

- `filter` is `true` (the whole operator core), an operator subset, or absent (not filterable — the
  default fails closed, like `include` / `fields` / `sort`). The core is the closed set named by the
  new `Filter` module: `Filter.operators` (`eq ne lt lte gt gte in nin isnull`), `Filter.Operator`
  and `Filter.isOperator`.
- Each filterable attribute gets a **literal codec** (`Schema.Codec<Type, string>`) derived from its
  schema's encoded form — `string`, `number`, `boolean`, or `Schema.NullOr` of one. The wire string is
  parsed strictly (`number` accepts only a finite decimal, `boolean` only `true` / `false`) and then
  decoded through the attribute schema itself, so refinements, brands, literal unions and
  `DateFromString` apply and `filter[priceCents][gt]=abc` fails decoding. An attribute whose encoded
  form is not a scalar cannot be declared filterable — `Resource.make` throws, naming it — unless the
  declaration supplies an explicit `filterLiteral` codec.
- To-one relationships are filter fields too: `Relationship.one(ref, { filter })` and
  `Relationship.optional(ref, { filter })` admit `eq ne in nin isnull` (`Relationship.filterOperators`;
  `true` means those five, an ordering operator is a definition-time error), valued by the related
  resource's id — the literal codec is the target's `Id` schema, resolved lazily, so
  `filter[author]=9` decodes to the branded id. `Resource.filterable(R)` lists them alongside the
  attributes; `Resource.sortable` stays attributes only.
- `Resource.sortable(R)` is typed as the literal key union, so it drops straight into
  `Query.schema(R, { sort: Resource.sortable(R) })` and `Endpoint.list(R, { sort: … })`. `sort: true`
  keeps meaning "every attribute".
- Type-level: `Resource.FilterableKeys<R>`, `Resource.FilterOperators<R, K>`, `Resource.SortableKeys<R>`,
  `Resource.FilterLiteralType<S>`, `Resource.Filterable<R>` and `Resource.FilterDeclaration`.

`Query.schema` is unchanged in this release; the `filter` URL codec over the declaration (the
grammar in `docs/filter-grammar.md`) follows separately.
