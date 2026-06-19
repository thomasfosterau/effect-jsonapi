---
"@thomasfosterau/effect-jsonapi": minor
---

Add `Resource.extend` for subtyping resources, plus accessors for extracting a resource's attributes and relationships.

### `Resource.extend` — subtype an existing resource

`Resource.extend(Base, type, options?)` defines a new resource that inherits the base's attributes and relationships, to which `options` adds more (keys present in `options` override the base's). JSON:API has no native subtyping, so the result is a _distinct_ resource type — its own `type` tag and branded id, with payloads and documents derived afresh — that shares the base's structure. Handy when several resources carry a common set of attributes/relationships defined once. `meta` is inherited from the base unless overridden.

```ts
const Account = Resource.make("accounts", {
  attributes: { email: Schema.NonEmptyString, createdAt: Schema.DateFromString },
  relationships: { organisation: Relationship.one(() => Organisation) }
})

// `admins` inherits email, createdAt and organisation, adding `permissions`.
const Admin = Resource.extend(Account, "admins", {
  attributes: { permissions: Schema.Array(Schema.String) }
})
```

### Extracting attributes and relationships

- `Resource.attributes(resource)` returns the attribute field map the resource was defined with; spread it into another resource's `attributes` to reuse its schemas.
- `Resource.relationships(resource)` returns the relationship descriptor record.
- Type-level counterparts `Resource.AttributesOf<R>` and `Resource.RelationshipsOf<R>`, plus `Resource.ExtendedAttributes` / `Resource.ExtendedRelationships` describing the merge `extend` performs.
