---
"@thomasfosterau/effect-jsonapi": minor
---

A malformed `Accept` weight no longer causes a 406 under `Middleware.layer` / `Middleware.negotiate` (#245). `Middleware.acceptIsAcceptable` now reads a `q` outside the RFC 9110 `qvalue` grammar (`q=`, `q=abc`, `q=2`, `q=-1`, `q=.5`, …) as the default weight `1`, as `Negotiation` already did, so the same `Accept` header gets the same verdict under either deployment shape. A JSON:API range whose only weight is malformed is now acceptable (200 rather than 406); a well-formed `q=0` is still a refusal.
