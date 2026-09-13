/**
 * effect-jsonapi — the schema-only entry point.
 *
 * `@thomasfosterau/effect-jsonapi/schema` re-exports every module whose module
 * graph depends on `effect` alone, so a consumer that wants JSON:API's *wire
 * types without the server* — a client decoding documents, a loader mapping
 * them into something else, a CLI or code generator producing them — never
 * resolves `effect/unstable/httpapi`.
 *
 * That matters beyond bundle size. `effect/unstable/*` is pre-stable, so an
 * unnecessary unstable peer is a version-compatibility surface: tree-shaking
 * may drop the code, but it cannot drop the peer. Only an entry point can.
 *
 * ```ts
 * import { Document, Resource } from "@thomasfosterau/effect-jsonapi/schema"
 * ```
 *
 * The modules left out are exactly the ones that bind JSON:API to Effect's
 * `HttpApi`: `ApiError`, `Endpoint`, `Group` and `Middleware`. Everything here
 * is also exported from the package root, so this is a packaging seam, not a
 * second API — the root import is unchanged and needs no knowledge of it.
 * Clients decoding *error* documents are served here too: the error document
 * schemas (`Document.ErrorDocument`, `Document.ErrorObject`) live in
 * `Document`, while `ApiError`'s error *classes* carry HTTP status and
 * content-type annotations and so belong to the HTTP tier.
 *
 * @packageDocumentation
 * @since 0.15.0
 */

/**
 * The {@link https://jsonapi.org/ext/atomic/ atomic operations extension} —
 * the operation and result document schemas. Encoding an atomic request is a
 * client-side concern; serving one is `Endpoint`'s.
 *
 * @since 0.15.0
 */
export * as Atomic from "./Atomic.js"

/**
 * Client-side helpers (`Client.narrowIncluded`).
 *
 * @since 0.15.0
 */
export * as Client from "./Client.js"

/**
 * JSON:API document-level schemas (links, meta, error objects, document
 * shapes).
 *
 * @since 0.15.0
 */
export * as Document from "./Document.js"

/**
 * The `filter` query family: the operator vocabulary (`Filter.Operator`,
 * `Filter.Op`, `Filter.isOperator`), the per-attribute declaration
 * (`Filter.able`), the filter AST (`Filter.Ast` and its constructors), its
 * normal form (`Filter.normalise`) and the grammar's profile URI
 * (`Filter.PROFILE_URI`). The URL codec is `Query.Filter(resource)`.
 *
 * @since 0.15.0
 */
export * as Filter from "./Filter.js"

/**
 * Document builders (`Handlers.data`, `Handlers.collection`, …). Named for
 * their primary use in request handlers, but they only assemble documents and
 * enforce the spec's compound-document rules — a fixture, a CLI or a code
 * generator can build a document with them just as well.
 *
 * @since 0.15.0
 */
export * as Handlers from "./Handlers.js"

/**
 * Lid (local id) resolution (`Lid.make`).
 *
 * @since 0.15.0
 */
export * as Lid from "./Lid.js"

/**
 * Typed JSON:API query parameters (`Query.schema`, `Query.Page`, …). A URL
 * codec: it turns query strings into typed values and back, which a client
 * building request URLs needs as much as a server parsing them.
 *
 * @since 0.15.0
 */
export * as Query from "./Query.js"

/**
 * JSON:API relationship constructors (`Relationship.one`, `Relationship.many`,
 * …).
 *
 * @since 0.15.0
 */
export * as Relationship from "./Relationship.js"

/**
 * JSON:API resource definitions (`Resource.make`) — the single source of truth
 * every document, filter and query schema is derived from, and so the anchor
 * of this tier rather than a server-side concern.
 *
 * @since 0.15.0
 */
export * as Resource from "./Resource.js"

/**
 * The `sort` query family's per-attribute declaration (`Sort.able`).
 *
 * @since 0.15.0
 */
export * as Sort from "./Sort.js"

/**
 * The JSON:API media type, `"application/vnd.api+json"`.
 *
 * @since 0.15.0
 * @category constants
 */
export { MEDIA_TYPE } from "./internal/media.js"
