# @thomasfosterau/effect-jsonapi

## 0.1.0

### Minor Changes

- 0ed140d: Add helpers for the JSON:API atomic operations extension (https://jsonapi.org/ext/atomic/), plus the base-spec lid (local id) concepts they build on.

  ### Lids as a first-class Resource concept
  - Every resource definition now derives `localIdentifier` (the `{ type, lid }` schema) and `lidRef(lid)` (typed local-identifier values), alongside the existing `identifier` / `ref(id)`.
  - `Resource.LocalIdentifier`, `Resource.Ref` (id-or-lid identifier union) and `Resource.RefValue` are exported from the Resource module.
  - The new standalone Lid module provides handler-side lid resolution: `Lid.make()` tracks the server-assigned ids of lid-created resources and resolves lid-based refs (including inside relationship linkage) back to typed identifiers; `Lid.UnknownLidError` signals refs to lids no operation declared.

  ### `Endpoint.operations` — the endpoint

  `Endpoint.operations([Article, Comment], options?)` builds a `POST /operations` endpoint whose payload is an `atomic:operations` document and whose success is a 200 `atomic:results` document. The operation union — resource add/update/remove, relationship operations, and lid-based refs — is derived from the resource definitions, like everything else in the library.

  Operations respect the relationship kinds: `add` operations require `one` relationships and exclude `paginated` ones (mirroring create payloads); `one` relationship updates can never be `null` while `optional` ones can; `many` and `paginated` relationships are managed through `add` / `update` / `remove` relationship operations.

  ### `Atomic` — schemas, constructors and handler helpers
  - **Discoverable operation derivation**: `Atomic.operationsFor(Article)` returns a named record of every operation derived for a resource — `add`, `update`, `remove`, and per-relationship operations by kind (`relationships.author.update`, `relationships.comments.add` / `update` / `remove`). The request document union is built from this record.
  - **Document schemas**: `RequestDocument`, `ResultDocument`, `Operations`, plus the building blocks (`AddOperation`, `UpdateOperation`, `RemoveOperation`, relationship operations, `ResourceRef` / `RelationshipRef`).
  - **Client-side constructors**: `Atomic.request`, `Atomic.add`, `Atomic.update`, `Atomic.remove`, `Atomic.updateRelationship`, `Atomic.addToRelationship`, `Atomic.removeFromRelationship` — typed operation values that encode to the spec's wire format.
  - **Handler-side helpers**: `Atomic.results` / `Atomic.result` / `Atomic.emptyResult` for building `atomic:results` documents; `Atomic.targetsResource` / `Atomic.targetsRelationship` / `Atomic.isRelationshipOperation` type guards that narrow the operation union to fully typed `data` / `ref` — dual data-first/curried APIs, so they drop into Effect's `Match` module (`Match.when(Atomic.targetsResource(Article), ...)`); `Atomic.operationPointer` for error sources.
  - **Constants**: `Atomic.EXTENSION_URI`, `Atomic.MEDIA_TYPE`, `Atomic.jsonapi`.

  ### Content negotiation: `ext` / `profile` media type parameters

  The middleware now implements JSON:API v1.1 §5 precisely: only media type parameters _other than_ `ext` / `profile` (or `ext` parameters carrying unsupported extension URIs) are rejected with 415/406. Previously any parameter was rejected, which also rejected spec-legal `profile` parameters.

  `Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })` configures the supported extension URIs; `Middleware.layer` is unchanged (no extensions). The `contentTypeIsAcceptable` / `acceptIsAcceptable` predicates accept an optional `NegotiationOptions` argument.

  Atomic operations responses carry the extension media type (`application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"`); requests are accepted with or without the `ext` parameter.

- 32dcaee: Clean-slate redesign: spec-compliant JSON:API v1.1 on Effect v4's HttpApi, by construction.

  The library is rebuilt around a resource-centric model in which a single definition is the source
  of truth and everything else — identifiers, payloads, documents, query parameters, endpoints,
  errors and middleware — is derived from it. Following the conventions of `effect` and
  `@effect/platform`, each module is exported as a namespace from the package root:

  ```ts
  import {
    ApiError,
    Atomic,
    Client,
    Document,
    Endpoint,
    Group,
    Handlers,
    Lid,
    Middleware,
    Query,
    Relationship,
    Resource,
  } from "@thomasfosterau/effect-jsonapi";
  ```

  ### Resources (`Resource.make`, `Relationship.one` / `optional` / `many` / `paginated`)
  - `Resource.make(type, { attributes, relationships?, meta? })` returns the resource object
    `Schema.Struct` augmented with derived members: `Id` (branded per-type id), `identifier`,
    `createPayload` (no `id`, optional `lid`), `updatePayload` (`id` required, partial attributes),
    `document()` and `collection()` (compound `included` union derived from the relationship graph).
  - Relationships reference other resource definitions through lazy thunks
    (`Relationship.one(() => Person)`) instead of strings — typos are compile errors and the
    relationship graph is walkable at runtime.

  ### Errors (`ApiError.make`)
  - One declaration produces a tagged Effect error class **and** its wire schema: a spec-compliant
    JSON:API error document at the declared HTTP status. No more hand-written
    `toDocument` / `fromDocument` round-trips.
  - Standard errors are predefined: `ApiError.BadRequest` (400), `ApiError.Forbidden` (403),
    `ApiError.NotAcceptable` (406), `ApiError.Conflict` (409), `ApiError.UnsupportedMediaType` (415).

  ### Endpoints & groups (`Endpoint.*`, `Group.make`)
  - `Endpoint.fetch` / `list` / `create` / `update` / `remove` adopt HttpApi's structured options
    model and bake in the JSON:API conventions: conventional paths, `application/vnd.api+json`,
    spec status codes (200/201/204), error documents, and typed query parameters.
  - `Endpoint.search` builds heterogeneous collection endpoints (search, feeds): `data` is a mixed
    array of several resource types discriminated by their `type` tags, with query features
    (`fields[TYPE]`, `include`, `sort`) derived across all of the searched resources.
    `Group.make` accepts a plain string name for groups that span resource types.
  - All constructors return plain `HttpApiEndpoint` / `HttpApiGroup` values — they compose with
    vanilla `HttpApi`, `HttpApiBuilder`, `HttpApiClient`, `HttpApiTest` and `OpenApi`.

  ### Typed query parameters (`Query.schema`, `Query.Page`)
  - First-class schemas for the spec's query families: `include` (literal paths derived from the
    relationship graph, 2 hops), `fields[TYPE]` (closed per-type attribute sets), `sort` (typed
    fields + direction), `page[*]` (`Query.Page.Offset` / `Query.Page.Number` / `Query.Page.Cursor`
    / custom), `filter[*]` (user-defined).
  - Flat bracket-keyed strings on the wire; ergonomic nested typed values in handlers; invalid
    values become spec-compliant 400 error documents.

  ### Client-side include narrowing (`Client.narrowIncluded`)
  - Narrows a response document's `included` member to exactly the resources reachable via the
    include paths the client requested (`["author"]` → `included: ReadonlyArray<Person>`), justified
    by the spec's "MUST NOT include unrequested resource objects" rule. Pure type-level operation;
    works with `HttpApiClient` and `HttpApiTest` clients.
  - `Resource.IncludePath<R>` / `Resource.IncludedFor<R, Paths>` exported for building custom typed
    client wrappers; `Resource.make(...).ref(id)` creates typed resource-identifier values.

  ### Protocol middleware (`Middleware`)
  - Content negotiation (415/406 per JSON:API §5) and schema-error translation (validation failures
    become JSON:API 400 documents) are `HttpApiMiddleware` services attached to every endpoint —
    the api cannot be built without providing `Middleware.layer`, so compliance cannot be forgotten.

  ### Handler-side document builders (`Handlers.data`, `Handlers.collection`)
  - Build response documents from resources; `included` is deduplicated by `(type, id)` and checked
    for the spec's full-linkage rule; pagination link helpers included.

  ### Packaging
  - The worked example moved out of the published package into `examples/blog`, exercised by an
    end-to-end test suite.
  - Every public symbol of the previous surface is removed or renamed. Pinned to
    `effect@>=4.0.0-beta.84`; Node.js 20+.
