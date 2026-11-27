---
"@thomasfosterau/effect-jsonapi": minor
---

Name applied profiles on the response media type (JSON:API 1.1 §6.1). Every endpoint constructor takes `profiles`, the URIs of the profiles its success responses apply, and declares its success media type with a `profile` parameter naming them, so the server sends `Content-Type: application/vnd.api+json; profile="…"` and the OpenAPI document shows the same. An endpoint built with `idempotency` names `Idempotency.PROFILE_URI` there itself. The conformance kit's `profile/idempotency/advertises-profile` rule is now a MUST and passes only on the media type parameter: naming the profile in `jsonapi.profile` alone fails it.
