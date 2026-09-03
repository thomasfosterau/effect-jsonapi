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
 *   Document,
 *   Endpoint,
 *   Filter,
 *   Group,
 *   Handlers,
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
export * as ApiError from "./ApiError.js"

/**
 * The {@link https://jsonapi.org/ext/atomic/ atomic operations extension}.
 *
 * @since 0.1.0
 */
export * as Atomic from "./Atomic.js"

/**
 * Client-side helpers (`Client.narrowIncluded`).
 *
 * @since 0.1.0
 */
export * as Client from "./Client.js"

/**
 * JSON:API document-level schemas (links, meta, error objects, document
 * shapes).
 *
 * @since 0.1.0
 */
export * as Document from "./Document.js"

/**
 * JSON:API endpoint constructors (`Endpoint.get`, `Endpoint.list`, …).
 *
 * @since 0.1.0
 */
export * as Endpoint from "./Endpoint.js"

/**
 * The `filter` query family: the operator vocabulary (`Filter.Operator`,
 * `Filter.Op`, `Filter.isOperator`), the per-attribute declaration
 * (`Filter.able`), the filter AST (`Filter.Ast` and its constructors), its
 * normal form (`Filter.normalise`) and the grammar's profile URI
 * (`Filter.PROFILE_URI`). The URL codec is `Query.Filter(resource)`.
 *
 * @since 0.13.0
 */
export * as Filter from "./Filter.js"

/**
 * JSON:API resource groups (`Group.make`).
 *
 * @since 0.1.0
 */
export * as Group from "./Group.js"

/**
 * Server-side document builders (`Handlers.data`, `Handlers.collection`, …).
 *
 * @since 0.1.0
 */
export * as Handlers from "./Handlers.js"

/**
 * Lid (local id) resolution (`Lid.make`).
 *
 * @since 0.1.0
 */
export * as Lid from "./Lid.js"

/**
 * JSON:API protocol middleware (`Middleware.layer`).
 *
 * @since 0.1.0
 */
export * as Middleware from "./Middleware.js"

/**
 * Typed JSON:API query parameters (`Query.schema`, `Query.Page`, …).
 *
 * @since 0.1.0
 */
export * as Query from "./Query.js"

/**
 * JSON:API relationship constructors (`Relationship.one`, `Relationship.many`,
 * …).
 *
 * @since 0.1.0
 */
export * as Relationship from "./Relationship.js"

/**
 * JSON:API resource definitions (`Resource.make`) — the single source of truth.
 *
 * @since 0.1.0
 */
export * as Resource from "./Resource.js"

/**
 * The `sort` query family's per-attribute declaration (`Sort.able`).
 *
 * @since 0.13.0
 */
export * as Sort from "./Sort.js"

/**
 * The JSON:API media type, `"application/vnd.api+json"`.
 *
 * @since 0.1.0
 * @category constants
 */
export { MEDIA_TYPE } from "./internal/media.js"
