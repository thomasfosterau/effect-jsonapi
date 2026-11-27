---
"@thomasfosterau/effect-jsonapi": minor
---

Add `Endpoint.action(R, name, options)` and `Endpoint.collectionAction(R, name, options)` for operations beside CRUD: `POST /<type>/:id/<name>` (with `params.id` decoded by the resource's `Id`) and `POST /<type>/<name>` by default. They carry the JSON:API media type, content negotiation, schema-error middleware, declared error documents, `idempotency` and `profiles`; `method`, `path`, `payload`, `query`, `success` (default: the resource's document) and `status` are options.
