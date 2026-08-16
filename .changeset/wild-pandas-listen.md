---
"@thomasfosterau/effect-jsonapi": minor
---

**`success` override on `Endpoint.get` / `list` / `create` / `update`.** The constructors bound their
response unconditionally to the resource's `document()` / `collection()`, so the only shape a
handler could answer with was the resource itself. They now take an optional `success` schema —
any `Schema.Top`, like `payload` — defaulting to exactly those documents, for apis whose response is
a _wire variant_ of the resource: an assembler that stringifies every link before the document
leaves the server emits `links.self` as a plain string, where the resource's own `Document.Link`
decodes an absolute reference to a `URL` and hands every generated-client call site the wrong type.
The override is served as `application/vnd.api+json` like every other body in the package, at 201
for `create` as before, and the document envelope is untouched, so `Handlers.offsetPaginationLinks`
and the other handler helpers still apply to an overridden `list`. The option is threaded through
`Endpoint.resource` / `Group.resource`'s per-endpoint `get` / `list` / `create` / `update` config,
so a generated group can adopt the wire variant without being spelled out by hand. Only the response
changes — path, params, query parameters, request payload, errors and middleware are untouched.
