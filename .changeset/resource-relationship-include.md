---
"@thomasfosterau/effect-jsonapi": minor
---

`Endpoint.resource` and `Group.resource` take a `relationshipInclude` option that turns on compound relationship documents (`Endpoint.getRelationship`'s `include`, #439) on the relationship endpoints they generate (#484). The top-level option (`true` or `{ depth }`) applies to every generated `getRelationship`; a relationship's own `relationships: { name: { relationshipInclude } }` overrides it and also takes a `{ paths }` allow-list or a declared `Include.Surface`. The generated endpoint's success document then admits `included`, so its handler can return `Handlers.linkage(ids, { included })`. Off by default: without the option nothing changes. A `paginated` relationship has no include paths, so a resource-wide setting legalises none there.
