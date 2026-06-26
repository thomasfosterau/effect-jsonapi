---
"@thomasfosterau/effect-jsonapi": minor
---

Unblock higher-level adoption with five additive features (no breaking changes):

- **Custom id-schema injection.** `Resource.make` accepts an optional `id` schema (any codec whose
  `Encoded` is `string`), so a resource's id can carry a consumer-defined brand instead of the
  auto-derived `Resource.Id`. The id type is threaded through `Resource`, `Identifier`,
  `updatePayload`, and the document schemas (a new, defaulted last type parameter — existing
  callers are unchanged). `Resource.Identifier(type, id?)` accepts a custom id schema too.

- **Tri-state update payloads.** A resource's `updatePayload` now models PATCH semantics distinctly
  per attribute via `Schema.optional`: an **absent** key means *leave unchanged*, an **`undefined`**
  value means *unset*, and a present value means *set*. Nullable attributes (`Schema.NullOr(...)`)
  therefore accept `value | null | undefined`.

- **Per-attribute annotations.** `Resource.attributeAnnotations(resource)` reads the Effect schema
  annotations stamped on each attribute (e.g. a `dbColumn` mapping authored with
  `schema.annotate({ ... })`), so metadata can ride alongside an attribute schema.

- **Flat ("command-style") payloads.** Resources expose `createInput` and `updateInput` — flat
  attribute structs without the JSON:API `{ data: { type, ... } }` envelope — for transports (RPC,
  remote functions) that carry a flat request shape.

- **Document value types.** `Handlers.DocumentValue` is now exported (with an optional `jsonapi`
  member and `Handlers.JsonApiObjectValue`), and `Document.Value<R>` names a data-document value
  type, so consumers can annotate their document-assembling functions instead of hand-rolling the
  envelope.

- **Decoupled middleware.** `Middleware.negotiate(headers, options?)` runs JSON:API §5 content
  negotiation outside Effect's HttpApi (returning the offending `UnsupportedMediaType` / `NotAcceptable`
  or `undefined`), and `ApiError.toDocument(error)` encodes any `ApiError` instance to a JSON:API
  error-document value — so a plain framework hook can reuse the negotiation and error machinery.
