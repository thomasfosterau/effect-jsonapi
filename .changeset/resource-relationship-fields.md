---
"@thomasfosterau/effect-jsonapi": minor
---

`Endpoint.resource` and `Group.resource` take a `relationshipFields` option that turns on sparse fieldsets (`Endpoint.getRelationship`'s `fields`, #485) on the relationship endpoints they generate (#489). It sits beside `relationshipInclude` and follows its shape: a top-level `true` applies to every generated `getRelationship`, and a relationship's own `relationships: { name: { relationshipFields } }` overrides it. Each such endpoint declares `fields[TYPE]` for the types its include paths reach, and its success document's `included` members admit any subset of their attributes, so its handler can answer with `onResource: Handlers.project(query.fields)`. Off by default, independent of the top-level `fields`, and a no-op where `relationshipInclude` is off.
