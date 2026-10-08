---
"@thomasfosterau/effect-jsonapi": patch
---

`Middleware.SchemaErrorsLive` no longer answers a failure to encode the handler's _response_ as a client 400. HttpApi reports a success value its endpoint's schema rejects as an `HttpApiSchemaError` of kind `"Body"` (the request body is `"Payload"`), and the middleware used to render it as a `bad_request` document whose `detail` and `source.pointer` described the server's own output. Response-side failures (`"Body"` and `"ResponseHeaders"`) now stay a defect: error reporting sees it at `Error` severity and the client receives the opaque JSON:API 500 of `ServerErrors.SERVER_ERROR`. `"ResponseHeaders"` was already passed through, but HttpApi answered that pass-through with an empty 400; it now gets the same 500. Request-validation failures are unchanged.
