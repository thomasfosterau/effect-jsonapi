/**
 * The `JsonApi` namespace: everything needed to define and serve a JSON:API
 * v1.1 compliant API with Effect's HttpApi.
 *
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApi } from "effect/unstable/httpapi"
 * import { JsonApi } from "effect-jsonapi"
 *
 * // 1. Resources — the single source of truth
 * const Person = JsonApi.Resource("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 *
 * const Article = JsonApi.Resource("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: { author: JsonApi.toOne(() => Person) }
 * })
 *
 * // 2. Errors — one-shot declarations
 * class ArticleNotFound extends JsonApi.Error<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String },
 *   detail: (e) => `Article ${e.id} not found`
 * }) {}
 *
 * // 3. Endpoints & groups — conventions baked in
 * const articles = JsonApi.Group(Article,
 *   JsonApi.Endpoint.fetch(Article, { include: true, errors: [ArticleNotFound] }),
 *   JsonApi.Endpoint.list(Article, { page: JsonApi.Page.Offset }),
 *   JsonApi.Endpoint.create(Article),
 *   JsonApi.Endpoint.update(Article, { errors: [ArticleNotFound] }),
 *   JsonApi.Endpoint.remove(Article, { errors: [ArticleNotFound] })
 * )
 *
 * const Api = HttpApi.make("blog").add(articles)
 * ```
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Resources: definitions, relationships, identifiers
// ---------------------------------------------------------------------------
export * from "./Resource.js"

// ---------------------------------------------------------------------------
// Documents: links, meta, error objects, document schemas
// ---------------------------------------------------------------------------
export * from "./Document.js"

// ---------------------------------------------------------------------------
// Handler-side document builders
// ---------------------------------------------------------------------------
export * from "./Handlers.js"

// ---------------------------------------------------------------------------
// Lid (local id) resolution
// ---------------------------------------------------------------------------
export * from "./Lid.js"

// ---------------------------------------------------------------------------
// Client-side helpers (include narrowing)
// ---------------------------------------------------------------------------
export * from "./Client.js"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Declares a JSON:API error in one shot — see `ApiError.make`.
 *
 * ```ts
 * class ArticleNotFound extends JsonApi.Error<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   code: "not_found",
 *   title: "Resource not found",
 *   fields: { id: Schema.String },
 *   detail: (e) => `Article ${e.id} not found`
 * }) {}
 * ```
 */
export { make as Error } from "./ApiError.js"
export { BadRequest, Conflict, Forbidden, NotAcceptable, UnsupportedMediaType } from "./ApiError.js"
export * as ApiError from "./ApiError.js"

// ---------------------------------------------------------------------------
// Endpoints & groups
// ---------------------------------------------------------------------------

export * as Endpoint from "./Endpoint.js"

/**
 * Creates an `HttpApiGroup` named after a resource's type — see `Group.make`.
 */
export { make as Group } from "./Group.js"

// ---------------------------------------------------------------------------
// Atomic operations extension
// ---------------------------------------------------------------------------

/**
 * The {@link https://jsonapi.org/ext/atomic/ atomic operations extension}:
 * request/result document schemas, operation value constructors, and handler
 * helpers (lid resolution, result building).
 *
 * ```ts
 * JsonApi.Endpoint.operations([Article, Comment])      // POST /operations
 *
 * JsonApi.Atomic.request(                               // client side
 *   JsonApi.Atomic.add(Article, { lid: "a1", attributes: { title: "Hello" } }),
 *   JsonApi.Atomic.remove(Comment, "5")
 * )
 * ```
 */
export * as Atomic from "./Atomic.js"

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

export * as Query from "./Query.js"
export { Page } from "./Query.js"

// ---------------------------------------------------------------------------
// Protocol middleware
// ---------------------------------------------------------------------------

export * as Middleware from "./Middleware.js"

// ---------------------------------------------------------------------------
// Media type
// ---------------------------------------------------------------------------

export { MEDIA_TYPE } from "./internal/media.js"
