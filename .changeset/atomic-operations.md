---
"effect-jsonapi": minor
---

Add helpers for the JSON:API atomic operations extension (https://jsonapi.org/ext/atomic/).

### `JsonApi.Endpoint.operations` — the endpoint

`Endpoint.operations([Article, Comment], options?)` builds a `POST /operations` endpoint whose
payload is an `atomic:operations` document and whose success is a 200 `atomic:results` document.
The operation union — resource add/update/remove, relationship operations, and `lid`-based refs —
is derived from the resource definitions, like everything else in the library.

### `JsonApi.Atomic` — schemas, constructors and handler helpers

- **Document schemas**: `RequestDocument`, `ResultDocument`, `Operations`, plus the building
  blocks (`AddOperation`, `UpdateOperation`, `RemoveOperation`, relationship operations,
  `Ref` / `ResourceRef` / `RelationshipRef`, `LocalIdentifier`).
- **Client-side constructors**: `Atomic.request`, `Atomic.add`, `Atomic.update`, `Atomic.remove`,
  `Atomic.updateRelationship`, `Atomic.addToRelationship`, `Atomic.removeFromRelationship`,
  `Atomic.lidRef` — typed operation values that encode to the spec's wire format.
- **Handler-side helpers**: `Atomic.results` / `Atomic.result` / `Atomic.emptyResult` for building
  `atomic:results` documents; `Atomic.lidMap()` for resolving client `lid`s to server-assigned ids
  across operations (including relationship linkage); `Atomic.targetsResource` /
  `Atomic.targetsRelationship` / `Atomic.isRelationshipOperation` type guards that narrow the
  operation union to fully typed `data` / `ref`; `Atomic.operationPointer` for error sources.
- **Constants**: `Atomic.EXTENSION_URI`, `Atomic.MEDIA_TYPE`, `Atomic.jsonapi`.

### Content negotiation: `ext` / `profile` media type parameters

The middleware now implements JSON:API v1.1 §5 precisely: only media type parameters *other than*
`ext` / `profile` (or `ext` parameters carrying unsupported extension URIs) are rejected with
415/406. Previously any parameter was rejected, which also rejected spec-legal `profile`
parameters.

`Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })` configures the supported extension
URIs; `Middleware.layer` is unchanged (no extensions). The `contentTypeIsAcceptable` /
`acceptIsAcceptable` predicates accept an optional `NegotiationOptions` argument.

Atomic operations responses carry the extension media type
(`application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"`); requests are accepted with or
without the `ext` parameter.
