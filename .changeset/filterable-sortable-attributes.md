---
"@thomasfosterau/effect-jsonapi": minor
---

**Per-attribute `filter` / `sort` declarations — `Filter.able` / `Sort.able` — with `Resource.filterable`
and `Resource.sortable`.** Filterability is now declared on the resource, per attribute, rather than
left to an open per-endpoint `filter: { key: Schema }` map. The declaration is made on the attribute
schema itself, with pipeable, Effect-native combinators, and rides with it as a schema annotation
(`Filter.AnnotationId` / `Sort.AnnotationId`) — the single source of truth the accessors read back —
so it is carried through `Resource.extend`, `Resource.attributes` spreads, `resource: "optional"`,
`Schema.NullOr` and `Schema.optionalKey`.

```ts
import { Filter, Resource, Sort } from "@thomasfosterau/effect-jsonapi"

const Product = Resource.make("products", {
  attributes: {
    name: Schema.NonEmptyString, // neither filterable nor sortable
    priceCents: Schema.Int.pipe(Filter.able([Filter.Op.eq, Filter.Op.gt, Filter.Op.lt]), Sort.able()),
    discontinued: Schema.Boolean.pipe(Filter.able()), // the whole operator core
    createdAt: Resource.readOnlyAttribute(Schema.DateFromString.pipe(Sort.able()))
  }
})

Resource.filterable(Product) // { priceCents: { operators, literal }, discontinued: { … } }
Resource.sortable(Product) // ["priceCents", "createdAt"]
Endpoint.list(Product, { sort: Resource.sortable(Product) })
```

- `Filter.able()` admits the whole operator core, `Filter.able([...])` a subset in the order given;
  `Sort.able()` allows `?sort=`. Absent means not filterable / not sortable — the default fails
  closed, like `include` / `fields` / `sort`. An empty list or an operator outside the core is a
  compile error and a definition-time throw. Annotate last, for the types: the runtime declaration
  survives a later `.check` / `.annotate` / `Schema.brand`, but any rebuild drops the type-level
  marker.
- `Resource.attribute(schema, { filter, filterLiteral, sort })` (and `Resource.readOnlyAttribute`)
  are **sugar** for those calls on the inner schema and stamp nothing else, so both spellings are
  indistinguishable to the accessors and to the types.
- The operator vocabulary is **schema-backed, not stringly typed**: `Filter.Operator` is a
  `Schema.Literals` over `eq ne lt lte gt gte in nin isnull`, from which `Filter.operators` and
  `Filter.isOperator` derive; `Filter.Op` spells the operators as typed constants (`Filter.Op.gt` is
  `"gt"`), so a typo is a compile error while plain strings stay accepted.
- Each filterable attribute gets a **literal codec** (`Schema.Codec<Type, string>`) derived from its
  schema's encoded form — `string`, `number`, `boolean`, or `Schema.NullOr` of one. The wire string is
  parsed strictly (`number` accepts only a finite decimal, `boolean` only `true` / `false`) and then
  decoded through the attribute schema itself, so refinements, brands, literal unions and
  `DateFromString` apply and `filter[priceCents][gt]=abc` fails decoding. An attribute whose encoded
  form is not a scalar cannot be declared filterable — `Resource.make` throws, naming it — unless the
  declaration supplies an explicit codec: `Filter.able(ops, { literal })`.
- To-one relationships are filter fields too: `Relationship.one(ref, { filter })` and
  `Relationship.optional(ref, { filter })` admit `eq ne in nin isnull` — `Relationship.FilterOperator`,
  a `Schema.Literals` narrowing `Filter.Operator` (`true` means those five, an ordering operator is a
  definition-time error) — valued by the related resource's id: the literal codec is the target's `Id`
  schema, resolved lazily, so `filter[author]=9` decodes to the branded id. `Resource.filterable(R)`
  lists them alongside the attributes; `Resource.sortable` stays attributes only.
- `Resource.sortable(R)` is typed as the literal key union, so it drops straight into
  `Query.schema(R, { sort: Resource.sortable(R) })` and `Endpoint.list(R, { sort: … })`. `sort: true`
  keeps meaning "every attribute".
- Type-level: `Resource.FilterableKeys<R>`, `Resource.FilterOperators<R, K>`, `Resource.SortableKeys<R>`,
  `Resource.Filterable<R>`, `Resource.FilterLiteralType<S>` (alias of `Filter.LiteralType`),
  `Filter.Declared<S, Op>` / `Sort.Declared<S>` (the phantom-marked schema types) and
  `Resource.FilterDeclaration` (the `filter` sugar's shape).

`Query.schema` is unchanged in this release; the `filter` URL codec over the declaration (the
grammar in `docs/filter-grammar.md`) follows separately.
