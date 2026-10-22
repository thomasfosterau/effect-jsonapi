---
"@thomasfosterau/effect-jsonapi": minor
---

Export a decoded-type alias next to each exported schema constant (`export type X = typeof X.Type`): `Document.AnyMeta`, `Url`, `LinkObject`, `ResourceLinks`, `RelationshipLinks`, `RelationshipLinksOpen`, `PaginatedRelationshipLinks`, `TopLevelLinks`, `JsonApiObject`, `ErrorSource` and `ErrorObject`; `Endpoint.FlatGetQuery`; `FlatQuery.PageOffset` and `Uuid`.

`Conformance.ContractViolation` is now a `Schema.TaggedError` (it was a `Data.TaggedError`): same tag, fields and `message`, and its fields now have a schema. `Idempotency.fingerprint` still dies if WebCrypto rejects SHA-256, but now does so explicitly. The `Client` docs no longer recommend `Effect.catchTag("ErrorResponse", …)`, which does not type-check against the generated client's static error type. Use `Client.isErrorResponse` instead.
