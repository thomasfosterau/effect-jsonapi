---
"@thomasfosterau/effect-jsonapi": minor
---

Clean-slate redesign: spec-compliant JSON:API v1.1 on Effect v4's HttpApi, by construction.

The library is rebuilt around a resource-centric model in which a single definition is the source
of truth and everything else — identifiers, payloads, documents, query parameters, endpoints,
errors and middleware — is derived from it. The public surface is the `JsonApi` namespace:

```ts
import { JsonApi } from "@thomasfosterau/effect-jsonapi"
```

### Resources (`JsonApi.Resource`, `JsonApi.toOne`, `JsonApi.toMany`)

- `JsonApi.Resource(type, { attributes, relationships?, meta? })` returns the resource object
  `Schema.Struct` augmented with derived members: `Id` (branded per-type id), `identifier`,
  `createPayload` (no `id`, optional `lid`), `updatePayload` (`id` required, partial attributes),
  `document()` and `collection()` (compound `included` union derived from the relationship graph).
- Relationships reference other resource definitions through lazy thunks
  (`JsonApi.toOne(() => Person)`) instead of strings — typos are compile errors and the
  relationship graph is walkable at runtime.

### Errors (`JsonApi.Error`)

- One declaration produces a tagged Effect error class **and** its wire schema: a spec-compliant
  JSON:API error document at the declared HTTP status. No more hand-written
  `toDocument` / `fromDocument` round-trips.
- Standard errors are predefined: `BadRequest` (400), `Forbidden` (403), `NotAcceptable` (406),
  `Conflict` (409), `UnsupportedMediaType` (415).

### Endpoints & groups (`JsonApi.Endpoint.*`, `JsonApi.Group`)

- `Endpoint.fetch` / `list` / `create` / `update` / `remove` adopt HttpApi's structured options
  model and bake in the JSON:API conventions: conventional paths, `application/vnd.api+json`,
  spec status codes (200/201/204), error documents, and typed query parameters.
- `Endpoint.search` builds heterogeneous collection endpoints (search, feeds): `data` is a mixed
  array of several resource types discriminated by their `type` tags, with query features
  (`fields[TYPE]`, `include`, `sort`) derived across all of the searched resources.
  `JsonApi.Group` accepts a plain string name for groups that span resource types.
- All constructors return plain `HttpApiEndpoint` / `HttpApiGroup` values — they compose with
  vanilla `HttpApi`, `HttpApiBuilder`, `HttpApiClient`, `HttpApiTest` and `OpenApi`.

### Typed query parameters (`JsonApi.Query`, `JsonApi.Page`)

- First-class schemas for the spec's query families: `include` (literal paths derived from the
  relationship graph, 2 hops), `fields[TYPE]` (closed per-type attribute sets), `sort` (typed
  fields + direction), `page[*]` (`Page.Offset` / `Page.Number` / `Page.Cursor` / custom),
  `filter[*]` (user-defined).
- Flat bracket-keyed strings on the wire; ergonomic nested typed values in handlers; invalid
  values become spec-compliant 400 error documents.

### Client-side include narrowing (`JsonApi.narrowIncluded`)

- Narrows a response document's `included` member to exactly the resources reachable via the
  include paths the client requested (`["author"]` → `included: ReadonlyArray<Person>`), justified
  by the spec's "MUST NOT include unrequested resource objects" rule. Pure type-level operation;
  works with `HttpApiClient` and `HttpApiTest` clients.
- `JsonApi.IncludePath<R>` / `JsonApi.IncludedFor<R, Paths>` exported for building custom typed
  client wrappers; `Resource.ref(id)` creates typed resource-identifier values.

### Protocol middleware (`JsonApi.Middleware`)

- Content negotiation (415/406 per JSON:API §5) and schema-error translation (validation failures
  become JSON:API 400 documents) are `HttpApiMiddleware` services attached to every endpoint —
  the api cannot be built without providing `JsonApi.Middleware.layer`, so compliance cannot be
  forgotten.

### Handler-side document builders (`JsonApi.data`, `JsonApi.collection`)

- Build response documents from resources; `included` is deduplicated by `(type, id)` and checked
  for the spec's full-linkage rule; pagination link helpers included.

### Packaging

- The worked example moved out of the published package into `examples/blog`, exercised by an
  end-to-end test suite.
- Every public symbol of the previous surface is removed or renamed. Pinned to
  `effect@>=4.0.0-beta.84`; Node.js 20+.
