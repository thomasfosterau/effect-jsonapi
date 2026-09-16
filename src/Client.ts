/**
 * The client side of JSON:API.
 *
 * Two things every consumer needs, and which a generated `HttpApiClient` does
 * not do for you:
 *
 *   - **Negotiation.** `HttpApiClient.make` sends `Accept: application/json`,
 *     so a client built from an api defined with this package is rejected by
 *     middleware from this package. {@link make} is `HttpApiClient.make` with
 *     the JSON:API media type already stamped on every request;
 *     {@link transform} and {@link jsonApiHeaders} are the same thing for a
 *     client assembled by hand, and {@link isMutatingMethod} is the
 *     which-requests-carry-a-content-type rule, single-sourced.
 *   - **Error documents.** {@link errorDocument} recovers the JSON:API error
 *     document a failed call carries, best-effort and without ever failing
 *     itself. For a body you already hold — a façade answering from a local
 *     replica, a fixture — `Document.decodeErrorDocument` needs no response at
 *     all, and stays reachable without the HTTP surface.
 *
 * {@link narrowIncluded} narrows a compound document's `included` member to
 * exactly the resources reachable via the include paths the client requested:
 *
 * ```ts
 * const include = ["author", "comments.author"] as const
 *
 * const document = yield* client.articles.get({
 *   params: { id: Article.Id.make("1") },
 *   query: { include }
 * }).pipe(Client.narrowIncluded(Article, include))
 *
 * document.included
 * //       ^ ReadonlyArray<Person | Comment> — Tag and other unrequested
 * //         resources are excluded from the type
 * ```
 *
 * The narrowing is justified by the spec: when a client supplies `include`,
 * "the server MUST NOT include unrequested resource objects in the `included`
 * section" (https://jsonapi.org/format/1.1/#fetching-includes). The runtime
 * decode still validates against the endpoint's full `included` union, so a
 * non-compliant server fails decoding rather than producing lies.
 *
 * @since 0.1.0
 */
import { Effect, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { HttpApi, HttpApiGroup } from "effect/unstable/httpapi"
import { HttpApiClient } from "effect/unstable/httpapi"
import * as Document from "./Document.js"
import { mediaType } from "./internal/media.js"
import type { Any, IncludedFor, IncludePath } from "./Resource.js"

/**
 * The minimal shape of a compound document value.
 *
 * @since 0.1.0
 * @category models
 */
export interface AnyDocument {
  readonly included?: ReadonlyArray<unknown> | undefined
}

/**
 * A document with its `included` member narrowed to the given resources'
 * decoded types.
 *
 * @since 0.1.0
 * @category type-level
 */
export type NarrowedDocument<Doc, Included extends Any> = Omit<Doc, "included"> & {
  readonly included?: ReadonlyArray<Included["Type"]>
}

/**
 * Narrows a response document's `included` member to the resources reachable
 * via the requested include paths.
 *
 * Dual API:
 * - data-last (pipe an `Effect` producing a document)
 * - data-first (narrow a document value directly)
 *
 * This is a type-level operation with no runtime cost.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Client, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString }
 * })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     comments: Relationship.many(() => Comment)
 *   }
 * })
 *
 * // `client` is a derived `HttpApiClient` for an api containing the articles group
 * type Client = {
 *   readonly articles: {
 *     readonly get: (request: {
 *       readonly params: { readonly id: string }
 *       readonly query: { readonly include?: ReadonlyArray<Resource.IncludePath<typeof Article>> }
 *     }) => Effect.Effect<ReturnType<typeof Article.document>["Type"]>
 *   }
 * }
 *
 * const getArticle = (client: Client) => {
 *   const include = ["author", "comments.author"] as const
 *   return client.articles
 *     .get({ params: { id: "1" }, query: { include } })
 *     .pipe(Client.narrowIncluded(Article, include))
 *   //   ^ Effect of a document whose `included` is narrowed to the requested
 *   //     resources — unrequested types are excluded from the type.
 * }
 * ```
 *
 * @since 0.1.0
 * @category combinators
 */
export const narrowIncluded: {
  <R extends Any, const Paths extends ReadonlyArray<IncludePath<R>>>(
    resource: R,
    include: Paths
  ): <Doc extends AnyDocument, E, Req>(
    effect: Effect.Effect<Doc, E, Req>
  ) => Effect.Effect<NarrowedDocument<Doc, IncludedFor<R, Paths>>, E, Req>
  <R extends Any, const Paths extends ReadonlyArray<IncludePath<R>>, Doc extends AnyDocument>(
    resource: R,
    include: Paths,
    document: Doc
  ): NarrowedDocument<Doc, IncludedFor<R, Paths>>
} = ((...args: ReadonlyArray<unknown>) =>
  args.length >= 3
    ? // data-first: the document itself
      args[2]
    : // data-last: an identity function over the effect
      (effect: unknown) => effect) as never

// ---------------------------------------------------------------------------
// Content negotiation
// ---------------------------------------------------------------------------

/**
 * The `ext` / `profile` parameters to advertise on the JSON:API media type.
 *
 * @since 0.15.0
 * @category models
 */
export interface NegotiationOptions {
  /** Extension URIs this client speaks, e.g. `Atomic.EXTENSION_URI`. */
  readonly extensions?: ReadonlyArray<string> | undefined
  /** Profile URIs this client understands, e.g. `Filter.PROFILE_URI`. */
  readonly profiles?: ReadonlyArray<string> | undefined
}

/**
 * Whether an HTTP method carries a request body's media type — `POST`,
 * `PUT`, `PATCH` and `DELETE`.
 *
 * `DELETE` is in the list on purpose, and it is the detail independent
 * implementations get wrong: a JSON:API `DELETE` may carry a body (relationship
 * removal does), and a bodyless one still has to declare what it *would* be
 * sending for a server negotiating §5 on every mutating request. Stamping the
 * content type on it costs nothing and omitting it is a 415 on some servers.
 *
 * Exported because it is a correctness detail, not sugar: a façade, a client
 * and a server that disagree about which requests are mutating disagree about
 * which requests negotiate.
 *
 * @example
 * ```ts
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * Client.isMutatingMethod("POST") // true
 * Client.isMutatingMethod("DELETE") // true — a JSON:API DELETE may carry a body
 * Client.isMutatingMethod("GET") // false
 * ```
 *
 * @since 0.15.0
 * @category guards
 */
export const isMutatingMethod = (method: string): boolean =>
  method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"

/**
 * Stamps the JSON:API media type onto a request: `Accept` on every request,
 * and `Content-Type` on the mutating ones ({@link isMutatingMethod}).
 *
 * The body bytes are untouched — only the label changes.
 *
 * `HttpApiClient.make` sends `Accept: application/json` and
 * `Content-Type: application/json`, so a client generated from an api built
 * with this package is rejected by this package's own
 * `Middleware.ContentNegotiationLive` until something does this. {@link make}
 * does it for you; this is the seam for a client assembled by hand.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { HttpClient, HttpClientRequest } from "effect/unstable/http"
 * import { Atomic, Client } from "@thomasfosterau/effect-jsonapi"
 *
 * const request = HttpClientRequest.post("/articles")
 * Client.jsonApiHeaders(request).headers["content-type"] // "application/vnd.api+json"
 *
 * // with the atomic extension advertised on both headers
 * const atomic = Client.jsonApiHeaders(request, { extensions: [Atomic.EXTENSION_URI] })
 * atomic.headers["accept"] // 'application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"'
 *
 * // as a client transform, which is what `Client.transform` does
 * const negotiating = (client: HttpClient.HttpClient) =>
 *   HttpClient.mapRequest(client, (request) => Client.jsonApiHeaders(request))
 * Effect.succeed(negotiating)
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const jsonApiHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  options?: NegotiationOptions
): HttpClientRequest.HttpClientRequest => {
  const value = mediaType(options)
  const accepted = HttpClientRequest.setHeader(request, "accept", value)
  return isMutatingMethod(request.method) ? HttpClientRequest.setHeader(accepted, "content-type", value) : accepted
}

/**
 * An `HttpClient` that negotiates JSON:API — {@link jsonApiHeaders} applied to
 * every request it sends.
 *
 * Pass it as `HttpApiClient.make`'s `transformClient`, or use {@link make},
 * which does exactly that.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { HttpClient } from "effect/unstable/http"
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * const negotiating = Effect.gen(function* () {
 *   const http = yield* HttpClient.HttpClient
 *   return Client.transform(http)
 * })
 * Effect.isEffect(negotiating) // true
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const transform = (client: HttpClient.HttpClient, options?: NegotiationOptions): HttpClient.HttpClient =>
  HttpClient.mapRequest(client, (request) => jsonApiHeaders(request, options))

/**
 * `HttpApiClient.make` with JSON:API content negotiation already applied — a
 * client that can talk to this package's server, as the default rather than as
 * something each consumer assembles.
 *
 * Takes everything `HttpApiClient.make` takes, plus the `ext` / `profile`
 * parameters to advertise. A `transformClient` of your own still runs, and runs
 * after the negotiation transform, so it can override the headers if it means
 * to.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { FetchHttpClient } from "effect/unstable/http"
 * import { HttpApi } from "effect/unstable/httpapi"
 * import { Client, Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } })
 * const Api = HttpApi.make("blog").add(Group.make(Article, Endpoint.get(Article)))
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* Client.make(Api, { baseUrl: "https://example.com" })
 *   return yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} })
 * }).pipe(Effect.provide(FetchHttpClient.layer))
 *
 * Effect.isEffect(program) // true
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const make = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options?: NegotiationOptions & {
    readonly baseUrl?: URL | string | undefined
    readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
    readonly transformResponse?:
      | ((effect: Effect.Effect<unknown, unknown, unknown>) => Effect.Effect<unknown, unknown, unknown>)
      | undefined
  }
) =>
  HttpApiClient.make(api, {
    ...options,
    // `HttpClient.mapRequest` appends its transformation, so the *last* client
    // wrapped is the last to run. Ours goes on first and the caller's on top of
    // it, so a caller who means to override a header we set can.
    transformClient: (client) => {
      const negotiating = transform(client, options)
      return options?.transformClient?.(negotiating) ?? negotiating
    }
  })

// ---------------------------------------------------------------------------
// Reading an error document off a failed call
// ---------------------------------------------------------------------------

/**
 * Best-effort recovery of the JSON:API error document a failed call carries.
 *
 * Takes the failure itself — an `HttpClientError`, or anything at all — and
 * **never fails**: a cause with no response, a body that is not JSON, a body
 * that is not a conformant error document, or a transport fault with no body
 * at all, are all `None`, and the caller falls back to a status-only message.
 * An error path that can throw its own error is worse than no error path.
 *
 * Reading the body consumes it.
 *
 * For a body you already hold — a façade synthesising a response locally, a
 * fixture — use `Document.decodeErrorDocument`, which this is built on and
 * which needs no response at all.
 *
 * @example
 * ```ts
 * import { Effect, Option } from "effect"
 * import { Client, Document } from "@thomasfosterau/effect-jsonapi"
 *
 * const describe = (cause: unknown) =>
 *   Client.errorDocument(cause).pipe(
 *     Effect.map(Option.match({
 *       onNone: () => "Request could not be completed",
 *       onSome: Document.errorMessage
 *     }))
 *   )
 *
 * Effect.runSync(describe(new Error("network down"))) // "Request could not be completed"
 * ```
 *
 * @since 0.15.0
 * @category utils
 */
export const errorDocument = (cause: unknown): Effect.Effect<Option.Option<Document.ErrorDocumentValue>> => {
  const response = (
    cause as { readonly response?: { readonly json?: Effect.Effect<unknown, unknown> } } | null | undefined
  )?.response
  const json = response?.json
  if (json === undefined) return Effect.succeed(Option.none())
  return json.pipe(
    Effect.map(Document.decodeErrorDocument),
    Effect.catchCause(() => Effect.succeed(Option.none<Document.ErrorDocumentValue>()))
  )
}
