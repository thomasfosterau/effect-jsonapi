---
"@thomasfosterau/effect-jsonapi": minor
---

`Endpoint.create` and `Endpoint.update` now answer a resource object whose `data.type` names a type the endpoint does not serve with JSON:API's required **409 Conflict** (`code: "conflict"`, `source.pointer: "/data/type"`) instead of a 400 (§Creating Resources / §Updating Resources → 409 Conflict). `Middleware.SchemaErrorsLive` decides it from the request body when the payload's decode failure is at `/data/type`; a `type` that is missing or not a string, every other malformed member, flat command-input payloads and relationship endpoints keep their 400.
