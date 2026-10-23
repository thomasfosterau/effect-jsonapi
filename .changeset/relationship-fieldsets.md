---
"@thomasfosterau/effect-jsonapi": minor
---

Sparse fieldsets treat relationships as fields, as JSON:API 1.1 does (#494). A resource's attributes and relationships are its "fields" together, so `?fields[articles]=title,author` is now legal: `Query.Fieldset`, the nested `fields` member and the flat `fields[TYPE]` parameters of `Query.schema` accept relationship names as well as attribute names, on every endpoint that declares `fields`, `relationshipFields` included. `Resource.RelationshipKeys` / `Resource.relationshipKeys` and `Resource.FieldKeys` / `Resource.fieldKeys` name that vocabulary.

`Handlers.project` now drops every relationship the set does not name, whole (its `links` and `meta` with its `data`), and omits a `relationships` member left empty, so an empty `?fields[TYPE]=` drops them all. `Handlers.Projected` types the result. The default document of an endpoint declaring `fields` makes each relationship optional, as it already made each attribute optional, so a client reads `doc.data.relationships?.author?.data` where it read `doc.data.relationships?.author.data`.

Dropping a relationship can unlink the `included` members it reached (`?include=author&fields[articles]=title`). The spec exempts that case from full linkage ("when relationship fields that would otherwise contain linkage data are excluded due to sparse fieldsets", §Compound Documents), and so do all four checks now:

- the document builders (`Handlers.data`, `collection`, `linkage`, `buildIncluded`) follow the linkage of every relationship a `Handlers.project` transform excluded, as the resource carried it before the transform. The transform carries its fieldset, through `Handlers.compose` too. A relationship a transform drops for any other reason is not exempt;
- `Middleware.SchemaErrorsLive` reads `fields[TYPE]` from the request and reports no member once its walk reaches a resource of a type the request names a fieldset for;
- the conformance kit's `spec/document/full-linkage` does the same with the probe's `fields[TYPE]`;
- `Assemble.relationship` now checks full linkage from its identifiers, as `Handlers.linkage` does, and throws on an `included` member they do not reach (#498). It used to deduplicate `included` without checking it.

The kit's `spec/query/sparse-fieldsets-primary`, `-included` and `-empty` rules judge `relationships` as well as `attributes`.
