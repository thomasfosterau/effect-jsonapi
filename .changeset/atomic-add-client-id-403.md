---
"@thomasfosterau/effect-jsonapi": minor
---

An atomic `add` operation carrying a client-generated id is refused with 403 Forbidden rather than having the id dropped (#464). `Atomic.AddOperation`'s resource object declares no `id`, so a `data.id` the client sent used to be dropped by the decode and the resource created under an id of the server's own. It is now rejected at `data/id`, when decoding and when encoding, as `Resource.createPayload` rejects one (#450), and `Middleware.SchemaErrorsLive` answers the whole request with a JSON:API 403 whose `source.pointer` is `/atomic:operations/N/data/id`, before the handler runs, so no operation is performed. `Endpoint.operations` takes a new `payload` option, as `Endpoint.create` does, so a request document whose `add` declares an `id` can accept client-generated ids.
