---
"@thomasfosterau/effect-jsonapi": minor
---

`Handlers.paginatedRelationship` takes an optional fourth argument, `{ self }`, which controls the relationship's `self` link. Omitted (or `undefined`), `self` is `/<type>/<id>/relationships/<name>` as before, so existing callers see no change. A string is used verbatim as the `self` link. `false` omits `self`, for an API that declares no relationship endpoint for that relationship, so it no longer has to advertise a link that answers 404. The return type follows the option: with `self: false` the value's `links` has no `self` member, and with a `string | false` known only at runtime it is the union of both shapes. `related` is always written. Because of that, `ReturnType<typeof Handlers.paginatedRelationship>` is now a union of the two shapes, so code that reads `x.links.self` off a value typed by that `ReturnType` has to narrow it first (for example with `"self" in x.links`).
