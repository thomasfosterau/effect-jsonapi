---
"@thomasfosterau/effect-jsonapi": minor
---

Add `JsonApiConfig`, an api-wide policy the middleware reads when its layer is built: `JsonApiConfig.layer({ extensions, allowedQueryParameters, checkLinkage, acceptWithoutJsonApi })` beneath `Middleware.layer` sets each for the whole api, and a `Middleware.layerWith` option still overrides it. The new `acceptWithoutJsonApi: "serve"` answers an `Accept` that names no JSON:API media type (`application/json`) with the document instead of a 406; the default stays `"notAcceptable"`.
