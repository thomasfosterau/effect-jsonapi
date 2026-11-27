---
"@thomasfosterau/effect-jsonapi": minor
---

Send `Vary: Accept` on every response the JSON:API middleware handles, success and error alike, merged with any `Vary` a handler set (JSON:API 1.1 §6.3: a server that supports `ext` or `profile` SHOULD). `varyAccept: false` on `JsonApiConfig.layer`, or on `Middleware.layerWith` (or `contentNegotiationLayer` / `schemaErrorsLayer`), leaves `Vary` to the api. `Negotiation.varyAccept` is the same merge for a host's own responses, and `Negotiation.errorResponse` sets it. The conformance kit gains `spec/content-negotiation/vary-accept`, and `Conformance.verify` now sends each in-process answer the way a server adapter does, so pre-response handlers apply.
