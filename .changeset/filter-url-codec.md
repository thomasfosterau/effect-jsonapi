---
"@thomasfosterau/effect-jsonapi": minor
---

**The `filter` URL codec: `filter: true`, `Query.Filter(resource)` and the `Filter.Ast`.**
The filter grammar in `docs/filter-grammar.md` is implemented over the per-attribute declaration.
`Endpoint.list(R, { filter: true })` (and `Query.schema(R, { filter: true })`) decodes the
`filter[...]` family to one normalised `Filter.Ast` root node, typed over the declared fields, and
encodes a tree back to its canonical wire form.

```ts
const Product = Resource.make("products", {
  attributes: {
    priceCents: Resource.attribute(Schema.Int, { filter: ["eq", "gt", "lt"] }),
    status: Resource.attribute(Schema.Literals(["draft", "live"]), { filter: true })
  }
})

Endpoint.list(Product, { filter: true })
// GET /products?filter[status]=live&filter[priceCents][lt]=1000
// → query.filter = And([Compare(lt, priceCents, 1000), Compare(eq, status, "live")])
```

- **Surface.** `filter[f]=v` is `eq`, `filter[f]=a,b` is `in`, `filter[f][op]=v` any of the closed
  core `eq ne lt lte gt gte in nin isnull`; the Drupal-style group form
  (`filter[g][group][conjunction]=OR`, `filter[c][condition][path|operator|value|memberOf]`) spells
  `OR`, `NOT`, nesting and repeated `(field, operator)` pairs. Literals are decoded through the
  attribute's literal codec, with `\,` and `\\` as the only escapes.
- **AST.** `Filter.Ast<Fields>` — `Compare`, `In`, `NotIn`, `IsNull`, `And`, `Or`, `Not` — plus the
  untyped `Filter.Node`, a runtime `Filter.Ast` schema, dumb constructors (`Filter.eq`, `Filter.isIn`,
  `Filter.and`, …) and `Filter.normalise`. `Query.FilterAst<R>` narrows `field` to the declared names
  and each literal to its field's type.
- **Canonical form.** Decoding normalises (values and members sorted and deduplicated); encoding
  emits the shorthand when it round-trips and the group form with pre-order ids otherwise, so the
  canonical string is a function of the tree alone. `Filter.PROFILE_URI` (also
  `Query.FILTER_PROFILE_URI`) is the grammar's profile URI.
- **Errors.** Every rejection — unknown field, undeclared operator, bad literal, malformed key,
  repeated key, and each structural fault of the group form — is one issue whose path is the
  offending flat key, and the schema-error middleware now renders a request-validation failure as an
  error object per reported issue, with `source.parameter` (`filter[age][gt]`, `page[limit]`),
  `source.header` or `source.pointer` (`/data/attributes/title`) and the issue's message as `detail`
  (`Middleware.schemaErrorDocument`). HttpApi decodes with `errors: "first"`, so a request part yields
  one error object; the `filter` family is the exception, its codec reporting every offending key
  together. A failure with no derivable source keeps the previous single-error document.
- The per-key `filter: { q: Schema.String }` map is unchanged and remains the escape hatch; a
  heterogeneous endpoint must use it (`filter: true` throws at definition time).
- `ApiError` wire schemas now decode an error document whose `meta` omits an optional field, instead
  of failing on the absent key.
