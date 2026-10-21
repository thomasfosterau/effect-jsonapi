---
"@thomasfosterau/effect-jsonapi": minor
---

**Behaviour change: a response that was served now answers 500.** `Middleware.SchemaErrorsLive` (and so `Middleware.layer`, `layerWith`, `layerHostNegotiated`, `Registry.layer` / `webHandler`) now checks full linkage on every 2xx document the endpoint _encoded_, with the same reachability walk the document builders and the conformance kit's `spec/document/full-linkage` rule make (#250). The builders check the value they build, but encoding through the endpoint's schema drops every relationship the resource does not declare, so an `included` member reached only through one — added by a cast, an `onResource` transform or an untyped data source — used to pass the builders and reach the client unreachable from the primary data. Such a response is now answered like one that fails to encode: a defect reported at `Error` severity (an `effect-jsonapi/ResponseEncodeError` whose message names the unreachable members) and the opaque JSON:API 500 of `ServerErrors.SERVER_ERROR`.

A builder's per-call `checkLinkage: false` cannot reach this check, since the encoded document carries no trace of it. To serve unlinked members deliberately, turn the wire check off for the layer: `Middleware.schemaErrorsLayer({ checkLinkage: false })` or `Middleware.layerWith({ checkLinkage: false })` (new `Middleware.SchemaErrorsOptions`).
