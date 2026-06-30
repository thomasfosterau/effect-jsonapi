# @thomasfosterau/effect-jsonapi

## 0.6.0

### Minor Changes

- 565071e: Decode JSON:API URI members to real `URL`s instead of plain strings.

  A new `Document.Url` schema decodes an **absolute** URI-reference to a WHATWG
  `URL` and leaves a **relative** reference (which the spec permits, and which the
  server-side `Handlers` helpers emit) as a `string` — its decoded type is
  `URL | string`. Both forms encode back to the original string, so the wire
  format is unchanged and relative links keep working.

  `Document.Url` is now used wherever the spec calls for a URI:

  - link targets — `Document.Link` and `LinkObject.href` (so `self` / `related` /
    pagination links across `TopLevelLinks`, `ResourceLinks`, `RelationshipLinks`
    and the error object's `about` / `type` links);
  - `LinkObject.describedby`;
  - the top-level `jsonapi` object's `ext` and `profile` URI arrays.

## 0.5.0

### Minor Changes

- f5e663f: Add **polymorphic resource families** (`Resource.family`) — a supertype over a set of member
  resources for heterogeneous "any node" use (closes #41).

  A family **is** the discriminated union over its members (decoded by the `type` tag) **and**
  structurally satisfies `Resource.Any`, so it can be used as primary `data`, as a compound
  `included` member, and — the headline — as a **relationship target**
  (`Relationship.one(() => family)` / `optional` / `many` / `paginated`), where linkage decodes for
  any member (keyed on the member `type`, never the family name) with no changes to the relationship
  machinery.

  - `Resource.family(Base, [A, B])` — base-anchored (recommended): the shared `Id` /
    `relationships` / attributes come from `Base`, so the shared id brand anchors "any member id"
    and dotted `?include=` paths through the family are meaningful (pair with members defined as
    `extend(Base, …, { inheritId: true })`).
  - `Resource.family("name", [A, B])` — named, no base: the shared id is a union of the members'
    ids and the shared relationships/attributes are the by-key intersection.
  - `family.document()` / `family.collection()` derive documents whose `data` is the member union
    and whose `included` spans every member's targets.
  - `Endpoint.polymorphic(family, …)` is the single-resource `GET /family/:id` (returning any
    member); `Endpoint.collection(family.members, …)` and `Group.make(family, …)` already cover the
    collection and group cases.
  - `Resource.isFamily`, `Resource.Family`, `Resource.FamilyIdentifier`,
    `Resource.FamilyDefaultIncluded`, `Resource.FamilyIncludePath`, `Resource.FamilyIncluded`.

  Strictly additive — no existing signatures change.

- dbada1f: Add **per-attribute projection descriptors** — control how each attribute appears in the resource
  object versus the four write projections (additive, no breaking changes):

  - **`Resource.attribute(schema, options)`.** Declares a per-attribute projection. Options (all
    optional; the defaults reproduce a plain `Schema` attribute):

    - `resource` — presence in the resource object schema + documents: `true` (default) or
      `"optional"` (an optional key).
    - `create` — presence in `createPayload` / `createInput`: `"required"` (default), `"optional"`,
      or `false` (excluded).
    - `update` — presence in `updatePayload` / `updateInput`: `"optional"` (default, tri-state) or
      `false` (excluded).
    - `clearable` — whether the update projection additionally accepts `null` to clear; defaults to
      whether the schema is `Schema.NullOr`.

  - **`Resource.readOnlyAttribute(schema)`.** Shorthand for a server-set attribute —
    `attribute(schema, { create: false, update: false })`: present in the resource object and
    documents, excluded from every write projection. Use it for version-chain timestamps
    (`createdAt`, `updatedAt`, …), counters and other server-computed state.

    ```ts
    const Article = Resource.make("articles", {
      attributes: {
        title: Schema.NonEmptyString,
        createdAt: Resource.readOnlyAttribute(Schema.Date),
        slug: Resource.attribute(Schema.String, { update: false }),
        summary: Resource.attribute(Schema.NullOr(Schema.String), {
          create: "optional",
        }),
      },
    });

    // Article.Type.attributes                  → { title, createdAt, slug, summary }
    // Article.createPayload … data.attributes  → { title, slug, summary? }   (no createdAt)
    // Article.updatePayload … data.attributes  → { title?, summary? }        (no createdAt, no slug)
    ```

  A plain `Schema` attribute keeps today's read-write behaviour, so the feature is fully opt-in. The
  descriptor rides on the attribute's schema value, so it flows through `attributeKeys`,
  `attributeAnnotations`, sparse `fields` and `include`, is carried through `Resource.extend`, and is
  respected by the Atomic `add` / `update` operations — consistently with the create/update payloads.
  The type-level projection helpers `Resource.Attribute`, `Resource.AttributeConfig`,
  `Resource.CreateAttributes` and `Resource.UpdateAttributes` (and the runtime
  `Resource.createAttributeFields` / `Resource.updateAttributeFields`) are exported too.

## 0.4.0

### Minor Changes

- dafe9ff: Unblock higher-level adoption with five additive features (no breaking changes):

  - **Custom id-schema injection.** `Resource.make` accepts an optional `id` schema (any codec whose
    `Encoded` is `string`), so a resource's id can carry a consumer-defined brand instead of the
    auto-derived `Resource.Id`. The id type is threaded through `Resource`, `Identifier`,
    `updatePayload`, and the document schemas (a new, defaulted last type parameter — existing
    callers are unchanged). `Resource.Identifier(type, id?)` accepts a custom id schema too.
  - **Subtype ids on extend.** `Resource.extend(Base, type, { inheritId: true })` brands the base's id
    schema with the child's type, so the child id accumulates the base's brand(s) and is assignable
    wherever the base id is expected — a true subtype relationship, transitive through an `extend`
    chain (`Admin.Id` ⊂ `Account.Id`). Defaults to `false` (an independent brand, as before).
  - **Tri-state update payloads.** A resource's `updatePayload` now models PATCH semantics distinctly
    per attribute via `Schema.optional`: an **absent** key means _leave unchanged_, an **`undefined`**
    value means _unset_, and a present value means _set_. Nullable attributes (`Schema.NullOr(...)`)
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

## 0.3.0

### Minor Changes

- 0da7692: Add `Query.Page.offset` (bounded, defaulted, optional plain-number) factory.

  `Query.Page.offset(options?)` returns the same `{ offset, limit }` field-map as the constant `Query.Page.Offset`, but configurable:

  - **Bounded** — `maxLimit` caps `limit` (a DoS guard); `minLimit` (default 1) floors it.
  - **Defaulted** — `defaultLimit` / `defaultOffset` fill in concrete values on decode when the wire key is absent; omit one to leave that field optional.
  - **Coercion-flexible** — `fromString: false` builds the fields from plain `Schema.Number` (encoded = number) instead of `FiniteFromString` (encoded = string), so the same schema works both as a numeric call-site input and behind a transport that coerces query strings (raw `HttpApiEndpoint` wrapped in `Schema.toCodecStringTree`).

  A page-number twin, `Query.Page.number(options?)`, applies the same bounds/defaults to the `size` field (1-based `number`). The existing `Page.Offset` / `Page.Number` / `Page.Cursor` constants are unchanged.

  ```ts
  Endpoint.list(Article, {
    page: Query.Page.offset({ maxLimit: 100, defaultLimit: 25 }),
  });
  ```

## 0.2.0

### Minor Changes

- 7cb72be: **Breaking:** `Document.DataDocument` is now a pure envelope — its `data` member is exactly the schema you pass, dropping the implicit `Schema.NullOr`. `DataDocument(R)` changes from `data: R | null` to `data: R`.

  JSON:API only permits `null` primary data for a single-resource request whose URL might correspond to a resource but currently doesn't ([§Fetching Resources → 200 OK](https://jsonapi.org/format/1.1/#fetching-resources-responses-200)). Fetch-existing / create (201) / update (200) always carry the resource — a missing one is a `404`, never `200 { data: null }` — so nullability is now the caller's compositional decision rather than something the constructor bakes in:

  ```ts
  DataDocument(Article); //                  data: Article            (was: Article | null)
  DataDocument(Schema.NullOr(Article)); //   data: Article | null
  DataDocument(Article.nullable()); //       data: Option<Article>, ⇆ null on the wire
  ```

  **Migration:** restore the old shape by wrapping the argument — `DataDocument(Schema.NullOr(R))`. Downstream this lets consumers delete hand-rolled non-null single-resource envelopes (e.g. a website's `ResourceDocument` becomes `Document.DataDocument(wireResource(resource))`).

  Ripple effects:

  - `Resource.document()` and `Endpoint.fetch` / `Endpoint.create` / `Endpoint.update` now produce non-null primary `data` (the canonical single-resource document for an existing resource).
  - `Endpoint.related` for a to-one relationship keeps the nullable form (`data: target | null`) to preserve the empty-linkage `data: null` case.
  - New `Resource.nullable()` method on every resource definition — `Article.nullable()` is `Schema.OptionFromNullOr(Article)`, the blessed, spec-clean nullable codec (`None ⇆ null`) for `Document.DataDocument(Article.nullable())`. Prefer it over effect's structural `Schema.Option` (`{ _tag, value }`), which would serialise a non-conformant body.

- 513119f: **Whole-resource endpoint generation:** `Endpoint.resource` and `Group.resource` derive an entire JSON:API endpoint set from a single resource definition — the full CRUD surface plus, for every relationship, the `related` and linkage endpoints appropriate to its kind — with `include` / `fields` / `sort` query parameters derived from the resource graph.

  ```ts
  // The whole group, fully typed, in one call:
  const articles = Group.resource(Article, {
    errors: [ArticleNotFound],
    page: Query.Page.Offset,
    // per-endpoint config overrides the top-level defaults:
    endpoints: {
      create: { errors: [TitleTaken] },
      list: { filter: { author: Schema.optionalKey(Schema.String) } },
    },
  });

  // Or get the endpoints as a tuple to compose with Group.make:
  const articles = Group.make(
    Article,
    ...Endpoint.resource(Article, { errors: [ArticleNotFound] }),
    Endpoint.list(Article, {
      name: "search",
      path: "/articles/search",
      filter: { q: Schema.String },
    }),
  );
  ```

  Defaults emit all five CRUD operations and every relationship's endpoints with `include` / `fields` / `sort` enabled; `page` and `filter` stay opt-in, and `errors` is applied uniformly. Everything is overridable, globally or per entry:

  - `endpoints` is an object keyed by operation (`get` / `list` / `create` / `update` / `delete`); each value is `true` (emit with defaults), `false` (omit), or an object configuring that endpoint (its `name` / `path` / `errors` and applicable query / `meta`), overriding the top-level defaults.
  - `relationships` is `true` (all, default) / `false` (none), or an object keyed by relationship name — each `false` to exclude, or an object to configure that relationship's endpoints. Relationships not mentioned are emitted with the defaults.
  - `meta` may be a `Schema` (overriding the document meta) or a function `(base) => schema` that _extends_ the resource's base meta rather than replacing it.

  The result is plain `HttpApiEndpoint` / `HttpApiGroup` values, so it composes with everything as before. See `Endpoint.ResourceOptions`.

  **Breaking:** several endpoint constructors are renamed, and the heterogeneous-collection constructor now takes an explicit route.

  - `Endpoint.fetch` → `Endpoint.get` (default endpoint name `"fetch"` → `"get"`).
  - `Endpoint.remove` → `Endpoint.delete` (default endpoint name `"remove"` → `"delete"`). `delete` is a reserved word, so it is re-exported from an internal implementation; `Endpoint.delete(...)` is the public name.
  - `Endpoint.fetchRelationship` → `Endpoint.getRelationship` (the relationship-linkage GET, for parity with `Endpoint.get`). The generated endpoint name `<name>Relationship` is unchanged, so handler keys and client methods are unaffected.
  - `Endpoint.search` → `Endpoint.collection`, and its `name` and `path` are now **required** (the `"search"` / `/search` defaults are removed). A polymorphic collection has no owning resource and so no conventional route; the constructor name no longer presumes "search" (it fits feeds and timelines just as well). The exported `SearchIncluded` type is renamed to `CollectionIncluded`.

  **Migration:** replace `Endpoint.fetch(R, …)` / `Endpoint.remove(R, …)` with `Endpoint.get(R, …)` / `Endpoint.delete(R, …)`, and rename the corresponding handler keys and client methods (`"fetch"` → `"get"`, `"remove"` → `"delete"`). Replace `Endpoint.fetchRelationship(R, …)` with `Endpoint.getRelationship(R, …)` — a rename of the constructor only; its `<name>Relationship` endpoint name (and thus its handler key) is unchanged. Replace `Endpoint.search([…], { … })` with `Endpoint.collection([…], { name: "search", path: "/search", … })` (the explicit `name` / `path` reproduce the old defaults), and rename any `SearchIncluded` references to `CollectionIncluded`. `Endpoint.removeRelationship` is unchanged — it matches the spec's "removing members" terminology and operates on relationship linkage, not whole resources.

- 55f8920: Add `Resource.extend` for subtyping resources, plus accessors for extracting a resource's attributes and relationships.

  ### `Resource.extend` — subtype an existing resource

  `Resource.extend(Base, type, options?)` defines a new resource that inherits the base's attributes and relationships, to which `options` adds more (keys present in `options` override the base's). JSON:API has no native subtyping, so the result is a _distinct_ resource type — its own `type` tag and branded id, with payloads and documents derived afresh — that shares the base's structure. Handy when several resources carry a common set of attributes/relationships defined once. `meta` is inherited from the base unless overridden.

  ```ts
  const Account = Resource.make("accounts", {
    attributes: {
      email: Schema.NonEmptyString,
      createdAt: Schema.DateFromString,
    },
    relationships: { organisation: Relationship.one(() => Organisation) },
  });

  // `admins` inherits email, createdAt and organisation, adding `permissions`.
  const Admin = Resource.extend(Account, "admins", {
    attributes: { permissions: Schema.Array(Schema.String) },
  });
  ```

  ### Extracting attributes and relationships
  - `Resource.attributes(resource)` returns the attribute field map the resource was defined with; spread it into another resource's `attributes` to reuse its schemas.
  - `Resource.relationships(resource)` returns the relationship descriptor record.
  - Type-level counterparts `Resource.AttributesOf<R>` and `Resource.RelationshipsOf<R>`, plus `Resource.ExtendedAttributes` / `Resource.ExtendedRelationships` describing the merge `extend` performs.

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
