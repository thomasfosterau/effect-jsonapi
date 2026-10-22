---
"@thomasfosterau/effect-jsonapi": patch
---

`ApiError.make` now leaves an optional field that an error instance doesn't carry out of the wire document's `meta` (#474). It used to write it as `undefined`, which is not JSON, so encoding the error failed and a client got a schema error instead of the declared error. For example, `fields: { id: Schema.String, pointer: Schema.optionalKey(Schema.String) }` constructed without `pointer`. Decoding already treated a missing `meta` member as absent, so such an error now round-trips.
