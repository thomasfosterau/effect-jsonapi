/**
 * effect-jsonapi — the schema-only entry point.
 *
 * `@thomasfosterau/effect-jsonapi/schema` re-exports every module whose import
 * graph depends on `effect` alone, so a consumer that wants JSON:API's *wire
 * types without the server* — a client decoding documents, a loader mapping
 * them into something else, a CLI or code generator producing them — never
 * resolves `effect/http-api`.
 *
 * That matters beyond bundle size. `effect/http` and `effect/http-api` are still
 * release-candidate APIs, so every unnecessary dependency on them is a version-compatibility surface that shifts
 * between releases: tree-shaking may drop the code, but it cannot drop the
 * dependency. Only an entry point can.
 *
 * ```ts
 * import { Document, Resource } from "@thomasfosterau/effect-jsonapi/schema"
 * ```
 *
 * Everything here is also exported from the package root, so this is a
 * packaging seam, not a second API — the root import is unchanged and needs no
 * knowledge of it. Clients decoding *error* documents are served here too: the
 * error document schemas (`Document.ErrorDocument`, `Document.ErrorObject`)
 * live in `Document`, while `ApiError`'s error *classes* carry HTTP status and
 * content-type annotations and so belong to the HTTP tier.
 *
 * The tier is derived from the real import graph, not from what each module
 * looks like it ought to be, and `test/entry-points.test.ts` pins it. Four
 * modules that read as schema-only are currently outside it: `Query` fails
 * with `ApiError.UnsupportedIncludePath` / `UnsupportedIncludeDepth` when
 * constraining include paths, and those are `HttpApi`-bound error classes, so
 * `Query` — and `Handlers`, `Lid` and `Atomic`, which reach `Query` — resolve
 * `httpapi` transitively. Freeing them means separating `ApiError`'s error
 * classes from their wire annotations, which is a change to a public module
 * rather than a packaging one.
 *
 * `Client` is outside it for a plainer reason: it negotiates content over an
 * `HttpClient` and derives a typed client from an `HttpApi`, so most of it is
 * the HTTP surface by definition. Its two schema-tier-shaped members —
 * `narrowIncluded`, a type-level operation with no runtime, and
 * `decodeErrorDocument`, which decodes a body through `Document`'s error
 * schemas alone — are not re-exported here, because a namespace cannot be
 * split across the two entry points without them ceasing to be the same module
 * object, which is itself pinned.
 *
 * @packageDocumentation
 * @since 0.15.0
 */
/**
 * JSON:API document-level schemas (links, meta, error objects, document
 * shapes).
 *
 * @since 0.15.0
 */
export * as Document from "./Document.js";

/**
 * The `filter` query family: the operator vocabulary (`Filter.Operator`,
 * `Filter.Op`, `Filter.isOperator`), the per-attribute declaration
 * (`Filter.able`), the filter AST (`Filter.Ast` and its constructors), its
 * normal form (`Filter.normalise`) and the grammar's profile URI
 * (`Filter.PROFILE_URI`). The URL codec is `Query.Filter(resource)`.
 *
 * @since 0.15.0
 */
export * as Filter from "./Filter.js";

/**
 * The flat list-input grammar — pure schema, so a client-safe models package
 * can declare its list inputs with it.
 *
 * @since 0.16.0
 */
export * as FlatQuery from "./FlatQuery.js";

/**
 * Declared `?include=` surfaces (`Include.make`, `Include.nested`) — one nested
 * declaration the accepted-path whitelist and the `included` union both
 * project from. Schema-tier because it derives both from resource definitions
 * alone; the third projection, the advertised query parameter, is `Query`'s
 * and stays in the HTTP tier with it.
 *
 * @since 0.15.0
 */
export * as Include from "./Include.js";

/**
 * JSON:API relationship constructors (`Relationship.one`, `Relationship.many`,
 * …).
 *
 * @since 0.15.0
 */
export * as Relationship from "./Relationship.js";

/**
 * JSON:API resource definitions (`Resource.make`) — the single source of truth
 * every document, filter and query schema is derived from, and so the anchor
 * of this tier rather than a server-side concern.
 *
 * @since 0.15.0
 */
export * as Resource from "./Resource.js";

/**
 * The `sort` query family's per-attribute declaration (`Sort.able`).
 *
 * @since 0.15.0
 */
export * as Sort from "./Sort.js";

/**
 * The JSON:API media type, `"application/vnd.api+json"`.
 *
 * @since 0.15.0
 * @category constants
 */
export { MEDIA_TYPE } from "./internal/media.js";
