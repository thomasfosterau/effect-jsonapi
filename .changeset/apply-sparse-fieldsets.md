---
"@thomasfosterau/effect-jsonapi": minor
---

Apply sparse fieldsets on the way out (JSON:API 1.1 §Sparse Fieldsets). `Middleware.layer` now projects every encoded 2xx document to the request's `fields[TYPE]`, primary data and `included` alike, so a handler that returns whole resources no longer answers with fields the request excluded. `sparseFieldsets` on `JsonApiConfig.layer`, or on `Middleware.layerWith` / `schemaErrorsLayer`, picks the behaviour: `"project"` (the default), `"verify"` (a violation is the opaque JSON:API 500) or `"handler"` (the previous behaviour, unchecked).
