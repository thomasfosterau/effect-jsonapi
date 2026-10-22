---
"@thomasfosterau/effect-jsonapi": minor
---

Relationship endpoints can serve compound documents (#439), as JSON:API 1.1 allows: `GET /articles/1/relationships/comments?include=comments.author` answers the comment identifiers as `data` and the comments and their authors in `included`.

- `Endpoint.getRelationship` takes an `include` option, shaped as the other read endpoints' is: `true`, `{ paths }`, `{ depth }` or a declared `Include.Surface`. The paths are the parent resource's, rooted at the relationship, so each one's first segment is the relationship's name. `include: true` legalises the parent's include paths that start with the relationship, to depth 2 from the parent. Any other path is a 400 naming the legal ones, and an allow-list or surface naming a path outside the relationship is a compile error (and throws at construction). A `paginated` relationship is never an include path of its parent, so its relationship endpoint has none to legalise. The success document gains an optional `included` admitting every resource the legal paths reach. Without `include` the endpoint is unchanged: still a 400 for `?include=`, and no `included` member.
- `Document.LinkageDocument` takes an `included` option (and an `Included` type parameter, after `M`). With it, the document has an optional `included` member; without it, the document is unchanged.
- `Handlers.linkage` takes `included` and `checkLinkage` options. The members are deduplicated among themselves but not against the identifiers, since an identifier is not a resource object, and full linkage is checked from the identifiers themselves (`Handlers.buildIncluded`'s seeding, #423). `onResource` shapes each member from its own value, not from the identifier that names it.
- `Assemble.relationship`'s `included` now reaches the wire through such an endpoint instead of being dropped by its schema.
- `Conformance`: the compound probe behind `spec/document/full-linkage`, `spec/document/no-duplicate-resources` and `spec/document/included-on-include` now asks a relationship endpoint declaring `include` for its own relationship (`?include=tags` on `/articles/1/relationships/tags`).
