---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** the server modules (`Assemble`, `Handlers`, `ResourceHandlers`, `Document`, `Endpoint`, `Query`, `FlatQuery`, `Group`, `Filter`, `Resource`, `Lid`) no longer spell "absent" as `undefined` in their options and results (`effect/prefer-option-over-null`, 3 of 6, #533). Options members are `readonly x?: T`, so under `exactOptionalPropertyTypes` they no longer accept an explicit `undefined`. A "maybe" result is an `Option`, and a record member that may be absent is optional.

Options members (`readonly x?: T | undefined` → `readonly x?: T`):

- `Assemble.Options`: `viewer`, `fields`, `include`, `includable`, `targets`, `depth`, `concurrency`, `capabilities`. `Assemble.CollectionOptions.included`, `Assemble.UnpaginatedCollectionOptions.query`, `Assemble.Pagination.query`, and `Assemble.RelationshipInput`'s `viewer`, `capabilities`, `included` and `fields`. `Assemble.OwnedCapabilitiesOptions`: `canModerate`, `relationship`. `Assemble.edgePage`'s `input.query`.
- `Handlers.data` / `collection` / `linkage` / `buildIncluded` options: `included`, `onResource`, `checkLinkage`. `Handlers.ResolveIncludedOptions`: `depth`, `concurrency`.
- `ResourceHandlers.IncludeConfig`: `depth`, `concurrency`. `ResourceHandlers.ReadOnlyConfig`: `viewer`, `capabilities`, `cache`, `include`, `maxPageLimit`. `ResourceHandlers.Config`: `transact`, `hiddenWrite`. `ResourceHandlers.RelatedConfig`: `includable`, `listQuery`, `viewer`, `capabilities`, `defaultPageLimit`, `maxPageLimit`, `concurrency`.
- `ResourceHandlers.GetRequest.query` and `RelatedRequest.query`: the decoded `?include=` (`Endpoint.FlatGetQuery`'s type) and `offset` / `limit`, with no `| undefined`. A request HttpApi decodes from the endpoints still assigns.
- `Document.DataDocument` / `CollectionDocument` / `LinkageDocument` / `Document` options: `included`, `meta`, `error`. `Document.WireOptions.toManyMeta`.
- `Endpoint.FlatDocumentOptions`: `included`, `toManyMeta`. `Endpoint.FlatRelatedOptions`: `query`, `included`.
- `Group.FlatReadOnlyOptions`: `filters`, `toManyMeta`. `Group.FlatOptions.hiddenWrites`.
- `Query.Options`: `include`, `fields`, `sort`. `Query.FlatListOptions` / `Query.flatList` options: `filters`, `include`. (`page` and `filter` changed with the type-level sentinels, #627.)
- `FlatQuery.PaginationOptions.defaultLimit`. `FlatQuery.SlugOptions`: `maxLength`, `reserved`. `FlatQuery.idList`'s `maxLength`.
- `Filter.able`'s `literal`. `Filter.LiteralCodecs`' `operators`.
- `Resource.make` / `Resource.extend` options: `id`, `maxUndeclaredMemberErrors`. `Resource.attribute` / `readOnlyAttribute`'s `filterLiteral`. `Resource.Any`: `declaredAttributes`, `maxUndeclaredMemberErrors`.

Results and signatures:

- `Handlers.resolveIncluded(primary, paths, targets, options?)` takes `paths: Option<ReadonlyArray<string>>` (was `ReadonlyArray<string> | undefined`) and returns `Effect<Option<ReadonlyArray<…>>, …>` (was the array or `undefined`). `Option.none()` still means "the request carried no `include`".
- `Handlers.withMeta(compute)`: `compute` returns `Option<M>` (was `M | undefined`). Return `Option.none()` for a resource it has nothing to say about.
- `Handlers.project(fields?)` / `Handlers.project(resource, fields?)` take an optional `fields` (was a required `F | undefined`). `Handlers.Fields`' index signature is `ReadonlyArray<string>` (was `ReadonlyArray<string> | undefined`), as a decoded `query.fields` is.
- `Assemble.OwnedCapabilitiesOptions.viewerId` returns `Option<string>` (was `string | undefined`).
- `Document.href(link)` takes a `Link` only. The `Link | undefined` overload is gone.
- `Lid.LidMap.id` returns `Option<string>` (was `string | undefined`). `LidMap.resolveLinkage`'s `relationships` is an optional parameter.
- `FlatQuery.suppliedValue(field?)` takes an optional parameter.
- `Filter.Annotation.literal` and `Resource.AttributeDescriptor.annotations` are optional members (were required `T | undefined`). `Resource.attributeAnnotations` (`AttributeAnnotationsOf`) has no key for an attribute that carries no annotations (was the key set to `undefined`).
- `Resource.family`'s `maxUndeclaredMemberErrors` on a name-only family is the default cap, `12` (was `undefined`, which the atomic operations read as `12`). It is typed `number`.

Migration for the apps:

- An options key whose value may be `undefined` is left out rather than set to `undefined`. Use the `definedMember` helper from the migration guide (#620) and spread one call per key: `Handlers.data(article, { ...definedMember("included", included), self })`. A value held as an `Option` takes the `Option` form of the same helper (`someMember`).
- `Handlers.resolveIncluded(x, query.include, targets)` becomes `Handlers.resolveIncluded(x, Option.fromUndefinedOr(query.include), targets)`. Hand its `Option` result to the builder with `someMember("included", included)`, or `Option.match` it.
- `Handlers.withMeta((r) => ({ … }))` becomes `Handlers.withMeta((r) => Option.some({ … }))`, and `() => undefined` becomes `() => Option.none()`.
- `viewerId: (v) => v?.id` becomes `viewerId: (v) => Option.fromNullishOr(v?.id)`.
- `Document.href(maybeLink)` becomes `Option.map(Option.fromUndefinedOr(maybeLink), Document.href)`. Use `Option.getOrUndefined` to keep the old behaviour.
- `lids.id(lid)` is an `Option`: `Option.getOrThrowWith(lids.id(lid), () => new Lid.UnknownLidError(lid))`, or `Option.getOrUndefined`.
- Wire shapes are unchanged.
