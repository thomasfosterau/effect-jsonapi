---
"@thomasfosterau/effect-jsonapi": minor
---

Sparse fieldsets for compound relationship documents (#485): `GET /articles/1/relationships/comments?include=comments.author&fields[people]=name` narrows the `included` authors.

- `Endpoint.getRelationship` takes a `fields` option, as the other read endpoints do. Beside `include`, it declares `fields[TYPE]` for every type a legal include path reaches (`Endpoint.RelationshipFieldsetTypes`), in the query's flat (wire) and nested records alike, and makes the document's `included` members of those types admit any subset of their attributes. The primary data is resource identifiers, which have no fields, so `fields[<target type>]` narrows only the `included` members of that type, and the parent's own type is not declared unless a path reaches it (`fields[articles]` on `/articles/1/relationships/comments` is a 400). Without `include` no type is declared.
- `Query.schema`'s `fields` option also takes an allow-list of wire types (`fields: ["comments", "people"]`), declaring `fields[TYPE]` for those of the derived set alone; a listed type outside it throws. `Query.FieldsetTypesOf` names the declared types.
- `Assemble.relationship` takes `fields`, applied to the `included` members only. `Handlers.linkage` already applied `onResource: Handlers.project(query.fields)` to them, leaving the identifiers alone.
- `Conformance`: `spec/query/sparse-fieldsets-included` now judges a relationship endpoint declaring `include` and `fields`, asking it for its own relationship (`?include=tags&fields[tags]=name`).
