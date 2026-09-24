/**
 * effect-jsonapi — Type-safe, spec-compliant JSON:API v1.1 on Effect's HttpApi.
 *
 * Every module is exported as a namespace from the package root, following the
 * convention of `effect` and `@effect/platform`:
 *
 * ```ts
 * import {
 *   ApiError,
 *   Atomic,
 *   Client,
 *   Conformance,
 *   Document,
 *   Endpoint,
 *   Filter,
 *   Group,
 *   Handlers,
 *   Idempotency,
 *   Include,
 *   Lid,
 *   Middleware,
 *   Query,
 *   Relationship,
 *   Resource,
 *   Sort
 * } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * const articles = Group.make(
 *   Article,
 *   Endpoint.get(Article, { include: true }),
 *   Endpoint.list(Article, { page: Query.Page.Offset })
 * )
 * ```
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
