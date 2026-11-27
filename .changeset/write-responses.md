---
"@thomasfosterau/effect-jsonapi": minor
---

`Endpoint.updateRelationship`, `addRelationship` and `removeRelationship` take `success`, `status`, `payloadMediaType` and `idempotency`, so a relationship write can answer 204, 202 or a meta-only 200 instead of the full linkage. `Endpoint.operations` takes `success`, `status` and `payloadMediaType`, so it can answer 204. The `success` option of every write endpoint also takes a list of responses (`Endpoint.Responses`), served as given, for an endpoint that answers 201 or 204, or 200 or 204, per request. Defaults are unchanged.
