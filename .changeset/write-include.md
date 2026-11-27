---
"@thomasfosterau/effect-jsonapi": minor
---

`Endpoint.create` and `Endpoint.update` take `include`, `fields` and `query`, as `Endpoint.get` does, so `POST /articles?include=author&fields[people]=name` can answer with a compound, sparse document. `Endpoint.resource` / `Group.resource` take them per write endpoint. Both stay off by default.
