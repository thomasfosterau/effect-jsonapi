---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking (wire):** `Negotiation.NOT_ACCEPTABLE`, `NOT_ACCEPTABLE_REFUSED` and `UNSUPPORTED_MEDIA_TYPE` now carry the codes `not_acceptable` and `unsupported_media_type`, the spellings `ApiError.NotAcceptable` / `ApiError.UnsupportedMediaType` (and so `Negotiation.toApiError`) already use. They replace the hyphenated `not-acceptable` / `unsupported-media-type` (#577). These are the canonical codes of the two negotiation errors: effect-ext's `Negotiate` returns a tagged verdict and defines none of its own. Migration: a host or test matching `errors[].code` on a 406 / 415 from `Negotiation.errorResponse` reads the underscored code.
