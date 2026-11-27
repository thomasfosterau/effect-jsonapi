---
"@thomasfosterau/effect-jsonapi": minor
---

Serve a `Resource.family`'s address as a supertype's: `Handlers.redirect(location)` answers a `polymorphic` read with a `308 Permanent Redirect` to the member's own URL, `Endpoint.polymorphicCreate(family)` creates whichever member `data.type` names through `POST /<family>` (a type outside the family is a 409 at `/data/type`), and `Client.make` now follows redirects, so the hop is transparent on any transport.
