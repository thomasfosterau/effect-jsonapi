---
"effect-jsonapi": minor
---

Add helpers for the JSON:API atomic operations extension (https://jsonapi.org/ext/atomic/), plus the base-spec lid (local id) concepts they build on.

### Lids as a first-class Resource concept

- Every resource definition now derives `localIdentifier` (the `{ type, lid }` schema) and `lidRef(lid)` (typed local-identifier values), alongside the existing `identifier` / `ref(id)`.
- `JsonApi.LocalIdentifier`, `JsonApi.Ref` (id-or-lid identifier union) and `JsonApi.RefValue` are exported from the Resource module.
- The new standalone Lid module provides handler-side lid resolution: `JsonApi.lidMap()` tracks the server-assigned ids of lid-created resources and resolves lid-based refs (including inside relationship linkage) back to typed identifiers; `JsonApi.UnknownLidError` signals refs to lids no operation declared.

### `JsonApi.Endpoint.operations` — the endpoint

`Endpoint.operations([Article, Comment], options?)` builds a `POST /operations` endpoint whose payload is an `atomic:operations` document and whose success is a 200 `atomic:results` document. The operation union — resource add/update/remove, relationship operations, and lid-based refs — is derived from the resource definitions, like everything else in the library.

Operations respect the relationship kinds: `add` operations require `one` relationships and exclude `paginated` ones (mirroring create payloads); `one` relationship updates can never be `null` while `optional` ones can; `many` and `paginated` relationships are managed through `add` / `update` / `remove` relationship operations.

### `JsonApi.Atomic` — schemas, constructors and handler helpers

- **Discoverable operation derivation**: `Atomic.operationsFor(Article)` returns a named record of every operation derived for a resource — `add`, `update`, `remove`, and per-relationship operations by kind (`relationships.author.update`, `relationships.comments.add` / `update` / `remove`). The request document union is built from this record.
- **Document schemas**: `RequestDocument`, `ResultDocument`, `Operations`, plus the building blocks (`AddOperation`, `UpdateOperation`, `RemoveOperation`, relationship operations, `ResourceRef` / `RelationshipRef`).
- **Client-side constructors**: `Atomic.request`, `Atomic.add`, `Atomic.update`, `Atomic.remove`, `Atomic.updateRelationship`, `Atomic.addToRelationship`, `Atomic.removeFromRelationship` — typed operation values that encode to the spec's wire format.
- **Handler-side helpers**: `Atomic.results` / `Atomic.result` / `Atomic.emptyResult` for building `atomic:results` documents; `Atomic.targetsResource` / `Atomic.targetsRelationship` / `Atomic.isRelationshipOperation` type guards that narrow the operation union to fully typed `data` / `ref` — dual data-first/curried APIs, so they drop into Effect's `Match` module (`Match.when(Atomic.targetsResource(Article), ...)`); `Atomic.operationPointer` for error sources.
- **Constants**: `Atomic.EXTENSION_URI`, `Atomic.MEDIA_TYPE`, `Atomic.jsonapi`.

### Content negotiation: `ext` / `profile` media type parameters

The middleware now implements JSON:API v1.1 §5 precisely: only media type parameters *other than* `ext` / `profile` (or `ext` parameters carrying unsupported extension URIs) are rejected with 415/406. Previously any parameter was rejected, which also rejected spec-legal `profile` parameters.

`Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })` configures the supported extension URIs; `Middleware.layer` is unchanged (no extensions). The `contentTypeIsAcceptable` / `acceptIsAcceptable` predicates accept an optional `NegotiationOptions` argument.

Atomic operations responses carry the extension media type (`application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"`); requests are accepted with or without the `ext` parameter.
