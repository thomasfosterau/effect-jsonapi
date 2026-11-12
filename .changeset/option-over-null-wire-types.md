---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** the wire-shape types are spelled from their schemas, and wire members that are optional in JSON:API no longer take an explicit `undefined` (part of #533).

Every `| null` in a wire type stays: `data: null`, `links.next: null` and nullable attributes are unchanged, and the respelled types (`Handlers.LinkageValue`, `LinksValue`'s `first` / `last` / `prev` / `next`, `ResourceValue`'s relationship `data`, `resolveIncluded`'s `primary`, `data`'s bound; `Atomic.RelationshipDataValue`, `ResultValue.data`, `result`'s bound; `Lid.RefLinkageValue`, `ResolvedLinkage`; `Assemble.RelationshipDocument.data`; `Client.hydrate`'s `data`; `Resource.attribute` / `readOnlyAttribute` / `Filter.able`'s nullable-schema match) are identical to the old ones. What changes, under `exactOptionalPropertyTypes`, is that these optional members are now `?: T`, as `Schema.optionalKey` decodes them, not `?: T | undefined`:

- `Assemble.ResourceLike`: `relationships`, `links`, `links.self`, `meta`
- `Assemble.RelationshipObject`: `data`, `links`, `meta`
- `Client.AnyDocument.included`, `Client.IncludedResource` (`attributes`, `relationships`, `links`, `meta`), `Client.DocumentMembers` (`meta`, `links`, `jsonapi`), `Client.ResourceDocument` / `CollectionDocument` `included`, `Client.LinkedResource.relationships`, `Client.hydrate`'s `document.included`
- `Conformance.WritePayload`: `attributes`, `relationships`, `meta`

`Client.readTotalCount`'s `source` is an optional parameter (`readTotalCount()` and `readTotalCount(undefined)` both still give `0`).

A decoded document or resource still assigns as it is. Code that builds one of these values with `{ links: maybeLinks }`, where `maybeLinks` might be `undefined`, stops compiling: leave the key out when the value is absent, spreading one call per key of the `definedMember` helper from the 0.22 migration notes (#620):

```ts
// before: { type, id, attributes, meta: row.meta }, with `row.meta` possibly `undefined`
const resource: Assemble.ResourceLike = {
  type,
  id,
  attributes,
  ...definedMember("meta", row.meta),
};
```
