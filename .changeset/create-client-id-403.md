---
"@thomasfosterau/effect-jsonapi": minor
---

`Endpoint.create` answers a client-generated id with 403 Forbidden rather than dropping it (#450). `Resource.createPayload`'s resource object declares no `id`, so a `data.id` the client sent used to be dropped by the decode and the resource created under an id of the server's own, answered 201. It is now rejected at `/data/id`, when decoding and when encoding, and `Middleware.SchemaErrorsLive` answers it with a JSON:API 403 whose `source.pointer` is `/data/id`, before the handler runs (JSON:API 1.1 §Client-Generated IDs). A `type` or member that fails beside the id keeps its 409 or 400. A create that should accept client ids passes a `payload` whose resource object declares an `id`.
