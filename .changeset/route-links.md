---
"@thomasfosterau/effect-jsonapi": minor
---

Add `Handlers.links(api, { base })`, an `onResource` transform that fills each resource's `links.self` and each relationship's `links.self` / `links.related` from the routes the api declares (`Endpoint.get`, `Endpoint.getRelationship`, `Endpoint.related`), following custom paths and prefixes and never overwriting a link the handler set. A relationship gets a `self` link only when its relationship endpoint is declared.
