---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance` gains four write rules, all run with the write fixture and `mutating: true` (#429). `spec/status/create-conflict-id` re-sends a create carrying the id the server just gave a resource the kit created, and wants a 409, or a 403 from a server without client-generated ids; the kit never mints an id. `spec/relationships/replace`, `spec/relationships/add` and `spec/relationships/remove` send a relationship `PATCH`, `POST` and `DELETE` linking a kit-created resource to the `ids` sample of the related type, and judge each by what the relationship endpoint reads back. Discovery now records the identifier types a relationship endpoint's success schema declares. The `Write semantics beyond the success responses` gap narrows to creation with a client-generated id (#456).
