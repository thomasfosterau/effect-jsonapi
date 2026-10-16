/**
 * effect-jsonapi — type-safe, spec-compliant JSON:API v1.1 on Effect's HttpApi.
 *
 * Every module is exported as a namespace from the package root; import what
 * you use: `import { Endpoint, Group, Query, Resource } from
 * "@thomasfosterau/effect-jsonapi"`. Each is also published as a subpath of
 * its own, `@thomasfosterau/effect-jsonapi/Resource` and so on, the same
 * module whichever way it is imported. The schema-only subset, whose import
 * graph is `effect` alone, is `@thomasfosterau/effect-jsonapi/schema`.
 *
 * @packageDocumentation
 * @since 0.1.0
 */

/**
 * One-shot JSON:API error declarations and the standard errors every endpoint
 * supports (`ApiError.make`, `ApiError.BadRequest`, …).
 *
 * @since 0.1.0
 */
export * as ApiError from "./ApiError.js";

/**
 * The {@link https://jsonapi.org/ext/atomic/ atomic operations extension}.
 *
 * @since 0.1.0
 */
export * as Atomic from "./Atomic.js";

/**
 * The server-side document assembler (`Assemble.resource`,
 * `Assemble.collection`, `Assemble.relationship`) over `Handlers`, with the
 * capability hooks (`Assemble.roleCapabilities`, `Assemble.ownedCapabilities`)
 * and the link / wire coercions.
 *
 * @since 0.16.0
 */
export * as Assemble from "./Assemble.js";

/**
 * Client-side helpers: content negotiation (`Client.make`,
 * `Client.jsonApiHeaders`, `Client.isMutatingMethod`), best-effort
 * error-document decoding (`Client.decodeErrorDocument`,
 * `Client.errorDocument`, `Client.errorMessage`, `Client.ErrorResponse`),
 * include narrowing and hydration (`Client.narrowIncluded`, `Client.related`,
 * `Client.walk`, `Client.hydrate`), the document readers
 * (`Client.readTotalCount`, `Client.hasNextPage`) and the page cursor
 * (`Client.readPageCursor`, `Client.pageHref`, `Client.pageWindow`).
 *
 * @since 0.1.0
 */
export * as Client from "./Client.js";

/**
 * The conformance kit (`Conformance.verify`, `Conformance.format`) — an
 * executable specification of JSON:API v1.1 and of this package's profile,
 * which a server is driven through to prove it conforms.
 *
 * @since 0.15.0
 */
export * as Conformance from "./Conformance.js";

/**
 * JSON:API document-level schemas (links, meta, error objects, document
 * shapes).
 *
 * @since 0.1.0
 */
export * as Document from "./Document.js";

/**
 * JSON:API endpoint constructors (`Endpoint.get`, `Endpoint.list`, …).
 *
 * @since 0.1.0
 */
export * as Endpoint from "./Endpoint.js";

/**
 * The `filter` query family: the operator vocabulary (`Filter.Operator`,
 * `Filter.Op`, `Filter.isOperator`), the per-attribute declaration
 * (`Filter.able`), the filter AST (`Filter.Ast` and its constructors), its
 * normal form (`Filter.normalise`) and the grammar's profile URI
 * (`Filter.PROFILE_URI`). The URL codec is `Query.Filter(resource)`.
 *
 * @since 0.13.0
 */
export * as Filter from "./Filter.js";

/**
 * The flat list-input grammar (`FlatQuery.pagination`, `FlatQuery.listInput`,
 * `FlatQuery.SortParam`, `FlatQuery.idList`, `FlatQuery.slug`).
 *
 * @since 0.16.0
 */
export * as FlatQuery from "./FlatQuery.js";

/**
 * JSON:API resource groups (`Group.make`).
 *
 * @since 0.1.0
 */
export * as Group from "./Group.js";

/**
 * Server-side document builders (`Handlers.data`, `Handlers.collection`, …).
 *
 * @since 0.1.0
 */
export * as Handlers from "./Handlers.js";

/**
 * Idempotent writes — the `Idempotency-Key` profile (`Idempotency.layer`,
 * `Idempotency.Store`, `Idempotency.PROFILE_URI`).
 *
 * @since 0.15.0
 */
export * as Idempotency from "./Idempotency.js";

/**
 * Declared `?include=` surfaces (`Include.make`, `Include.nested`) — one
 * nested declaration the accepted-path whitelist, the `included` union and the
 * advertised parameter all project from.
 *
 * @since 0.15.0
 */
export * as Include from "./Include.js";

/**
 * Lid (local id) resolution (`Lid.make`).
 *
 * @since 0.1.0
 */
export * as Lid from "./Lid.js";

/**
 * JSON:API protocol middleware (`Middleware.layer`).
 *
 * @since 0.1.0
 */
export * as Middleware from "./Middleware.js";

/**
 * Media type annotation combinators for hand-rolled JSON:API endpoints
 * (`MediaType.asJsonApi`, `MediaType.asMediaType`).
 *
 * @since 0.15.0
 */
export * as MediaType from "./MediaType.js";

/**
 * The representation verdict for a host serving JSON:API on its page URLs
 * (`Negotiation.make`, `Negotiation.requestForRouter`,
 * `Negotiation.errorResponse`).
 *
 * @since 0.16.0
 */
export * as Negotiation from "./Negotiation.js";

/**
 * Typed JSON:API query parameters (`Query.schema`, `Query.Page`, …).
 *
 * @since 0.1.0
 */
export * as Query from "./Query.js";

/**
 * The handler registry and router (`Registry.FamilyFor`, `Registry.checkFamily`,
 * `Registry.webHandler`).
 *
 * @since 0.16.0
 */
export * as Registry from "./Registry.js";

/**
 * JSON:API relationship constructors (`Relationship.one`, `Relationship.many`,
 * …).
 *
 * @since 0.1.0
 */
export * as Relationship from "./Relationship.js";

/**
 * JSON:API resource definitions (`Resource.make`) — the single source of truth.
 *
 * @since 0.1.0
 */
export * as Resource from "./Resource.js";

/**
 * The server handler factory (`ResourceHandlers.make`,
 * `ResourceHandlers.readOnly`, `ResourceHandlers.related`) — the handler-side
 * counterpart of `Group.flat` / `Group.flatReadOnly`.
 *
 * @since 0.16.0
 */
export * as ResourceHandlers from "./ResourceHandlers.js";

/**
 * The server's error seam: the domain error catalogue, the `JsonapiError`
 * carrier, `ServerErrors.fromTaggedError` and `ServerErrors.respond`.
 *
 * @since 0.16.0
 */
export * as ServerErrors from "./ServerErrors.js";

/**
 * The `sort` query family's per-attribute declaration (`Sort.able`).
 *
 * @since 0.13.0
 */
export * as Sort from "./Sort.js";

/**
 * The JSON:API media type, `"application/vnd.api+json"`.
 *
 * @since 0.1.0
 * @category constants
 */
export { MEDIA_TYPE } from "./internal/media.js";

// ---------------------------------------------------------------------------
// Declaration-emit names (#348)
// ---------------------------------------------------------------------------
//
// The TypeScript checker does not follow a namespace alias (`export * as X`)
// when declaration emit looks for a name. So a type an endpoint's *inferred*
// type mentions is nameable in a consumer's `.d.ts` only through a namespace
// that consumer's file imports itself, or through a module that exports the
// type directly. Without one, `export const x = Endpoint.get(R)` fails with
// TS2883 / TS4023 — or the checker inlines the type structurally until it
// hits a name it cannot spell, such as `effect`'s `NodeInspectSymbol` inside
// an inlined error class.
//
// Since #385 every module is a public subpath with its own declaration file
// (`@thomasfosterau/effect-jsonapi/Query` exports `QuerySchema` directly), so
// declaration emit can always name a type through its module. The root
// aliases below came first (#348); they stay for 0.17.0 and are deprecated.
// Each type is canonical in its namespace, and a name that would be
// ambiguous at the root carries its namespace as a prefix. Every alias is
// type-only: a class or value keeps its runtime form under its namespace
// (`ApiError.BadRequest`, …). `test/declaration-emit.test.ts` compiles
// `test/emitted/declaration-emit*.types.ts` as a consumer, through them.

export type {
  /**
   * `ApiError.Wire`, at the package root so declaration emit can name it: the
   * endpoint error schema of an `ApiError` class.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   *
   * @deprecated Use `ApiError.Wire`, or import `Wire` from
   * `@thomasfosterau/effect-jsonapi/ApiError` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category models
   */
  Wire as ApiErrorWire,
  /**
   * `ApiError.BadRequest`, at the package root so declaration emit can name
   * it: the `SchemaErrors` middleware's error, in every client method's error
   * channel.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the class, use `ApiError.BadRequest`.
   *
   * @deprecated Use `ApiError.BadRequest`, or import `BadRequest` from
   * `@thomasfosterau/effect-jsonapi/ApiError` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category errors
   */
  BadRequest,
  /**
   * `ApiError.Conflict`, at the package root so declaration emit can name it:
   * the error `Group.flat` declares on its `create` and `update` endpoints.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the class, use `ApiError.Conflict`.
   *
   * @deprecated Use `ApiError.Conflict`, or import `Conflict` from
   * `@thomasfosterau/effect-jsonapi/ApiError` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category errors
   */
  Conflict,
  /**
   * `ApiError.NotAcceptable`, at the package root so declaration emit can name
   * it: a `ContentNegotiation` middleware error, in every client method's
   * error channel.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the class, use `ApiError.NotAcceptable`.
   *
   * @deprecated Use `ApiError.NotAcceptable`, or import `NotAcceptable` from
   * `@thomasfosterau/effect-jsonapi/ApiError` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category errors
   */
  NotAcceptable,
  /**
   * `ApiError.UnsupportedMediaType`, at the package root so declaration emit
   * can name it: a `ContentNegotiation` middleware error, in every client
   * method's error channel.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the class, use `ApiError.UnsupportedMediaType`.
   *
   * @deprecated Use `ApiError.UnsupportedMediaType`, or import `UnsupportedMediaType` from
   * `@thomasfosterau/effect-jsonapi/ApiError` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category errors
   */
  UnsupportedMediaType,
} from "./ApiError.js";

export type {
  /**
   * `Atomic.Operations`, at the package root so declaration emit can name it:
   * the payload of `Endpoint.operations`.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the value, use `Atomic.Operations`.
   *
   * @deprecated Use `Atomic.Operations`, or import `Operations` from
   * `@thomasfosterau/effect-jsonapi/Atomic` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category models
   */
  Operations as AtomicOperations,
  /**
   * `Atomic.Result`, at the package root so declaration emit can name it: one
   * result object of `Endpoint.operations`' success document.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the value, use `Atomic.Result`.
   *
   * @deprecated Use `Atomic.Result`, or import `Result` from
   * `@thomasfosterau/effect-jsonapi/Atomic` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category models
   */
  Result as AtomicResult,
} from "./Atomic.js";

export type {
  /**
   * `Document.CollectionDocument`, at the package root so declaration emit can
   * name it: the collection document of `Group.flat`'s list endpoint.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the value, use `Document.CollectionDocument`.
   * This is the document schema `Document.CollectionDocument` — not
   * `Assemble.CollectionDocument` or `Client.CollectionDocument`, which are
   * different types with the same name.
   *
   * @deprecated Use `Document.CollectionDocument`, or import `CollectionDocument` from
   * `@thomasfosterau/effect-jsonapi/Document` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category models
   */
  CollectionDocument,
  /**
   * `Document.DataDocument`, at the package root so declaration emit can name
   * it: the single-resource document of `Group.flat`'s other endpoints.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the value, use `Document.DataDocument`.
   * This is the document schema `Document.DataDocument` — not an `Assemble.*`
   * or `Client.*` document type (`Assemble.ResourceDocument`,
   * `Client.ResourceDocument`).
   *
   * @deprecated Use `Document.DataDocument`, or import `DataDocument` from
   * `@thomasfosterau/effect-jsonapi/Document` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category models
   */
  DataDocument,
  /**
   * `Document.WireSchema`, at the package root so declaration emit can name
   * it: the wire form of a document `Group.flat` serves.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   *
   * @deprecated Use `Document.WireSchema`, or import `WireSchema` from
   * `@thomasfosterau/effect-jsonapi/Document` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category models
   */
  WireSchema,
} from "./Document.js";

export type {
  /**
   * `Endpoint.IncludedResources`, at the package root so declaration emit can
   * name it.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   *
   * @deprecated Use `Endpoint.IncludedResources`, or import `IncludedResources` from
   * `@thomasfosterau/effect-jsonapi/Endpoint` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category type-level
   */
  IncludedResources,
  /**
   * `Endpoint.ReachableIncluded`, at the package root so declaration emit can
   * name it.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   *
   * @deprecated Use `Endpoint.ReachableIncluded`, or import `ReachableIncluded` from
   * `@thomasfosterau/effect-jsonapi/Endpoint` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category schemas
   */
  ReachableIncluded,
  /**
   * `Endpoint.SparseResource`, at the package root so declaration emit can
   * name it.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   *
   * @deprecated Use `Endpoint.SparseResource`, or import `SparseResource` from
   * `@thomasfosterau/effect-jsonapi/Endpoint` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category schemas
   */
  SparseResource,
  /**
   * `Endpoint.SparseUnion`, at the package root so declaration emit can name
   * it.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   *
   * @deprecated Use `Endpoint.SparseUnion`, or import `SparseUnion` from
   * `@thomasfosterau/effect-jsonapi/Endpoint` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category schemas
   */
  SparseUnion,
} from "./Endpoint.js";

export type {
  /**
   * `Idempotency.Headers`, at the package root so declaration emit can name
   * it: the request headers of a write endpoint that accepts an
   * `idempotency-key`.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the value, use `Idempotency.Headers`.
   *
   * @deprecated Use `Idempotency.Headers`, or import `Headers` from
   * `@thomasfosterau/effect-jsonapi/Idempotency` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category schemas
   */
  Headers as IdempotencyHeaders,
  /**
   * `Idempotency.KeyInProgress`, at the package root so declaration emit can
   * name it: an idempotency middleware error, in the error channel of a client
   * method whose endpoint accepts an `idempotency-key`.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the class, use `Idempotency.KeyInProgress`.
   *
   * @deprecated Use `Idempotency.KeyInProgress`, or import `KeyInProgress` from
   * `@thomasfosterau/effect-jsonapi/Idempotency` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category errors
   */
  KeyInProgress as IdempotencyKeyInProgress,
  /**
   * `Idempotency.KeyMismatch`, at the package root so declaration emit can
   * name it: an idempotency middleware error, in the error channel of a client
   * method whose endpoint accepts an `idempotency-key`.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the class, use `Idempotency.KeyMismatch`.
   *
   * @deprecated Use `Idempotency.KeyMismatch`, or import `KeyMismatch` from
   * `@thomasfosterau/effect-jsonapi/Idempotency` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category errors
   */
  KeyMismatch as IdempotencyKeyMismatch,
  /**
   * `Idempotency.Middleware`, at the package root so declaration emit can name
   * it: the middleware of a write endpoint declared with `idempotency: true`.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the class, use `Idempotency.Middleware`.
   *
   * @deprecated Use `Idempotency.Middleware`, or import `Middleware` from
   * `@thomasfosterau/effect-jsonapi/Idempotency` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category services
   */
  Middleware as IdempotencyMiddleware,
} from "./Idempotency.js";

export type {
  /**
   * `Middleware.ContentNegotiation`, at the package root so declaration emit
   * can name it: the middleware on every endpoint.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the class, use `Middleware.ContentNegotiation`.
   *
   * @deprecated Use `Middleware.ContentNegotiation`, or import `ContentNegotiation` from
   * `@thomasfosterau/effect-jsonapi/Middleware` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category services
   */
  ContentNegotiation,
  /**
   * `Middleware.CreatedLocation`, at the package root so declaration emit can
   * name it: the middleware on every `create` endpoint.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the class, use `Middleware.CreatedLocation`.
   *
   * @deprecated Use `Middleware.CreatedLocation`, or import `CreatedLocation` from
   * `@thomasfosterau/effect-jsonapi/Middleware` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category services
   */
  CreatedLocation,
  /**
   * `Middleware.SchemaErrors`, at the package root so declaration emit can
   * name it: the middleware on every endpoint.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   * It names only the type: for the class, use `Middleware.SchemaErrors`.
   *
   * @deprecated Use `Middleware.SchemaErrors`, or import `SchemaErrors` from
   * `@thomasfosterau/effect-jsonapi/Middleware` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category services
   */
  SchemaErrors,
} from "./Middleware.js";

export type {
  /**
   * `Query.BracketedKeys`, at the package root so declaration emit can name
   * it: the flat list query `Group.flat` builds.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   *
   * @deprecated Use `Query.BracketedKeys`, or import `BracketedKeys` from
   * `@thomasfosterau/effect-jsonapi/Query` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category models
   */
  BracketedKeys,
  /**
   * `Query.QuerySchema`, at the package root so declaration emit can name it:
   * the query schema of every read endpoint.
   *
   * Type-only alias, kept at the root for declaration emit (#348) and
   * superseded by the module's subpath export (#385).
   *
   * @deprecated Use `Query.QuerySchema`, or import `QuerySchema` from
   * `@thomasfosterau/effect-jsonapi/Query` instead; once this alias is removed,
   * declaration emit names it through that subpath.
   * @since 0.17.0
   * @category models
   */
  QuerySchema,
} from "./Query.js";
