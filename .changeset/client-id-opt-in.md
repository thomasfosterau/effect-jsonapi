---
"@thomasfosterau/effect-jsonapi": minor
---

Accept client-generated ids declaratively: `Endpoint.create(R, { clientId: "optional" | "required" })` decodes `data.id` with the resource's `Id` schema and keeps the default payload's closed members, so no hand-built payload is needed. `Resource.clientIdPayload(R, { presence, id })` is that payload, and `ApiError.DuplicateId` is the 409 for a taken id, naming `/data/id`. The default is unchanged: a `data.id` is still a 403.
