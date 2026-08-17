---
"@thomasfosterau/effect-jsonapi": minor
---

**The injected `IdSchema` is threaded through the endpoint constructors.** `Resource.make` has
accepted a custom id schema since 0.4.0, but no endpoint constructor carried it: `Endpoint.get` /
`list` / `create` / `update` / `delete`, the relationship constructors, `Endpoint.resource` and
`Group.resource` all typed their resource parameter as `Resource<Type, Attributes, Rels, Meta>`,
whose fifth type parameter defaults to the derived `Id<Type>`. A resource carrying the consumer's
own branded id — the case the injection was added for — was therefore not assignable to any of
them, and had to be cast at the call site even though the runtime was already correct (the
constructors read `resource.Id` verbatim).

Each of those constructors now takes the id schema as a type parameter of its own, defaulting to
the derived `Id<Type>`, and threads it into `Resource<…>`:

```ts
const InvoiceId = Schema.String.pipe(Schema.brand("AccountId"), Schema.brand("InvoiceId"))
const Invoice = Resource.make("invoices", {
  id: InvoiceId,
  attributes: { total: Schema.Number }
})

// no cast at any of these, and `:id` is `InvoiceId` rather than `Id<"invoices">`
Endpoint.get(Invoice)
Group.resource(Invoice)
```

The brand reaches the `:id` path parameter and the documents each endpoint declares by default —
the success document, the collection, `updatePayload` — so a handler and a generated client see the
resource's real id type rather than the derived one. No runtime behaviour changes: the constructors
already passed `resource.Id` through, and a resource with no injected id infers exactly what it
inferred before.

The parameter sits fifth, where it sits on `Resource` itself, on the constructors whose remaining
parameters are all defaulted (`get` / `list` / `create` / `update` / `delete`, `Endpoint.resource`,
`Group.resource`), and ahead of the parameter list's first required member elsewhere
(`Endpoint.related` and the relationship constructors, `ResourceOptions`, `ResourceEndpoint`,
`ResourceEndpoints`). That is visible only to code that instantiates one of them explicitly —
`typeof Endpoint.get<…>`, `ResourceOptions<…>` — never to a normal call site.
