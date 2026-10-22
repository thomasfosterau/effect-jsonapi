---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** `Middleware.RequestPart` no longer includes `"Body"`; it is now `"Params" | "Headers" | "Query" | "Payload"`, the request-side kinds of HttpApi's `HttpApiSchemaError`. Inside HttpApi `"Body"` names a failure to encode the handler's _response_, not a part of the request, so it never belonged in a type named `RequestPart`. Migration: replace `"Body"` with `"Payload"` in calls to `Middleware.schemaError` and `Middleware.schemaErrorDocument` — the 400 document is the same (a body issue still gets a `source.pointer`), except that `schemaError`'s `detail` reads `Request payload failed validation` rather than `Request body failed validation`.
