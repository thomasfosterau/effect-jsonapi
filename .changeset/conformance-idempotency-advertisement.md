---
"@thomasfosterau/effect-jsonapi": minor
---

`Conformance` gains `profile/idempotency/advertises-profile-uri`, the first rule for the Idempotency-Key profile, a SHOULD citing `docs/idempotency.md` §1. Given a `writes` fixture and `mutating: true`, the kit sends one create, with a fresh `Idempotency-Key`, to each create endpoint whose headers declare the header (`idempotency: true` or `"required"`), and its 2xx must name `Idempotency.PROFILE_URI` in the top-level `jsonapi.profile` member or in the media type's `profile` parameter. Either place passes. A package-built endpoint passes when its handler answers with `jsonapi: Idempotency.jsonapi`. Without `mutating: true`, without a fixture, or with no endpoint declaring the header, the rule skips and says which. A create the server does not accept, or a 2xx with no document, decides nothing.

The `The Idempotency-Key profile` coverage gap no longer calls this rule non-mutating and unwritten. It is narrowed to what a retried write does (replay, fingerprint mismatch, in-flight, key scope), which still needs byte-for-byte replay (#162, #165).
