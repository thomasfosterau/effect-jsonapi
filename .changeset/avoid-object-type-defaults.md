---
"@thomasfosterau/effect-jsonapi": major
---

The empty-object defaults of the published generics are spelled `Record<never, never>` instead of `{}` (#436), so the `effect/avoid-object-type` lint rule is back at `error`. `Record<never, never>` is the same type as `{}`: it has no keys, `keyof` it is `never` and it is the identity of an intersection, so every resolved type stays as it was. What changes is the text of the published declarations, and so what a consumer's hover and declaration emit print:

- `Resource.Resource<Type, Attributes, Rels extends Relationships = Record<never, never>, …>`
- `Resource.Parameter<Type, Attributes, Rels extends Relationships = Record<never, never>, …>`
- `Resource.make<Type, Attributes, const Rels extends Relationships = Record<never, never>, …>`
- `Resource.extend<…, const ExtraAttributes extends Schema.Struct.Fields = Record<never, never>, const ExtraRels extends Relationships = Record<never, never>, …>`
- `ApiError.make()<Tag, const Fields extends Schema.Struct.Fields = Record<never, never>>`, so an error declared without `fields` is an `ApiErrorClass<Self, Tag, Record<never, never>>` (and `ApiError.Wire<Self, Tag, Record<never, never>>`), among them `ApiError.Forbidden`, `NotAcceptable`, `UnsupportedMediaType`, `Idempotency.KeyMismatch` and `KeyInProgress`
- `FlatQuery.listInput<const Fields extends Schema.Struct.Fields = Record<never, never>>`
- `Endpoint.resource<…, const Endpoints extends EndpointsOption<…> = Record<never, never>, …>` and `Group.resource<…>` likewise
- the empty branches of `Query.NestedFields`, `Query.FlatFields` and `Query.FlatList`, and of `Handlers.DocumentValue` (`meta` / `jsonapi` absent), are `Record<never, never>` instead of `{}`

**Migration.** Code that omits these type arguments needs no change. Code that names the default explicitly can keep writing `{}`, which is still assignable both ways; to match the published spelling (and pass `effect/avoid-object-type` in your own lint), write `Record<never, never>`. Snapshot or string comparisons of printed types (`.d.ts` emit, hover text) see `Record<never, never>` where they saw `{}`.
