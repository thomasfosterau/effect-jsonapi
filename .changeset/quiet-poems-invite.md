---
"@thomasfosterau/effect-jsonapi": minor
---

Three additions for consumers whose transport doesn't match the package's defaults. All are opt-in
and default to today's behaviour.

**`payload` override on `Endpoint.create` / `Endpoint.update`.** Both constructors bound their
request body unconditionally to the resource's `createPayload` / `updatePayload` — the nested
JSON:API envelope. They now take an optional `payload` schema, defaulting to that envelope, for apis
whose write contract is a flat command input (the resource's own `createInput` / `updateInput`, or
any schema of your own) while still answering with JSON:API documents. The option is threaded
through `Endpoint.resource` / `Group.resource`'s per-endpoint `create` / `update` config, so a
generated group can adopt flat writes without being spelled out by hand. Only the request body
changes — path, params, success document, errors and middleware are untouched.

**`Query.bracketPageKeys`.** A standalone combinator re-keying a flat `{ limit, offset, … }` struct's
page cursor to the spec-canonical `page[limit]` / `page[offset]` wire family, leaving the decoded
type and every other field's wire key alone. `Query.schema`'s `page` option was the only route to
those bracket keys, and it always nests the decoded cursor under `page` — this serves consumers who
merge pagination flat into their own query struct instead of composing the whole query through
`Query.schema`. No change to existing `Query.schema` paths.

**Middleware usable without the endpoint constructors.** `Middleware.schemaError(part)` returns the
JSON:API 400 that request validation produces, standalone — the counterpart to the existing
`Middleware.negotiate`, so a framework hook that owns the URL can answer byte-identically to an
`Endpoint`-built api. `Middleware.layerHostNegotiated` (and `Middleware.ContentNegotiationPassthrough`
alone) satisfies the constructors' `ContentNegotiation` requirement without performing §5, for apis
whose host already negotiated content upstream and would otherwise negotiate twice.
