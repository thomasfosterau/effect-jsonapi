/**
 * Client-side helpers: content negotiation, error-document decoding and
 * include narrowing.
 *
 * A JSON:API client needs three things this package can own on its behalf, and
 * that every consumer otherwise re-derives:
 *
 *   - **Negotiation.** A client derived by `HttpApiClient.make` sends no
 *     `Accept` header at all, and no `Content-Type` on a bodyless mutation such
 *     as `DELETE` (a payload-carrying `POST` gets one from its body schema).
 *     That misses the spec's client responsibilities on both counts, and leaves
 *     a host that serves HTML and JSON:API on one origin nothing to select on —
 *     so every consumer writes the same request transform. {@link make} is that
 *     transform pre-applied; {@link transform} applies it to an existing
 *     `HttpClient`, {@link jsonApiHeaders} to a single request, and
 *     {@link mediaType} builds the header value itself.
 *   - **Error documents.** {@link decodeErrorDocument} is the one best-effort
 *     decoder — a non-conforming body (HTML from a proxy, a truncated payload,
 *     an opaque 502) degrades to `Option.none()` rather than throwing a second
 *     error inside the error path. {@link errorDocument} reaches it from a
 *     failed call's `HttpClientError`, and {@link errorMessage} takes the first
 *     human-readable message out of the result.
 *   - **Include narrowing.** {@link narrowIncluded}, below.
 *
 * ## One decoder, one media type
 *
 * The surface is shaped so that a façade-served error and a network-served
 * error for the same URL are indistinguishable to the client *by construction*,
 * rather than by two implementations agreeing:
 *
 *   - {@link decodeErrorDocument} takes a **body**, not a response. It is the
 *     supported entry point, not an implementation detail of the cause-based
 *     {@link errorDocument} — which is defined in terms of it. A façade that
 *     synthesises responses locally (an offline read answered with a 503, say)
 *     and never holds an `HttpClientError` decodes through exactly the same
 *     code path as the network transport, and both accept exactly what
 *     `ApiError.toDocument` renders.
 *   - {@link mediaType} builds what the client sends from the same definition
 *     the server's response annotations use, so the `ext` parameter syntax the
 *     client emits is the syntax {@link Middleware.acceptIsAcceptable} accepts.
 *   - {@link isMutatingMethod} is public because it is a correctness detail,
 *     not sugar: `Content-Type` goes on **every** mutating request, including a
 *     bodyless `DELETE`. A façade and a server that both call it cannot
 *     disagree about which requests carry the label.
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
 * @example
 * ```ts
 * import { Effect, Option, Schema } from "effect"
 * import { FetchHttpClient } from "effect/unstable/http"
 * import { HttpApi } from "effect/unstable/httpapi"
 * import { Client, Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 * const Api = HttpApi.make("blog").add(Group.make(Article, Endpoint.get(Article)))
 *
 * // A client that negotiates with this package's own middleware, and a failure
 * // path that reads the error document the server sent.
 * const program = Effect.gen(function* () {
 *   const client = yield* Client.make(Api, { baseUrl: "https://example.com" })
 *   return yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} })
 * }).pipe(
 *   Effect.catch((cause) =>
 *     Effect.gen(function* () {
 *       const document = yield* Client.errorDocument(cause)
 *       return Option.match(document, {
 *         onNone: () => "Request failed",
 *         onSome: Client.errorMessage
 *       })
 *     })
 *   ),
 *   Effect.provide(FetchHttpClient.layer)
 * )
 *
 * console.log(typeof program.pipe) // the program is built, not run
 * ```
 *
 * @since 0.1.0
 */
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import type { HttpApi, HttpApiGroup } from "effect/unstable/httpapi"
import { HttpApiClient } from "effect/unstable/httpapi"
import { ErrorDocument as ErrorDocumentSchema, ErrorObject } from "./Document.js"
import { baseMediaType, MEDIA_TYPE, mediaTypeWith } from "./internal/media.js"
import type { NegotiationOptions as ServerNegotiationOptions } from "./Middleware.js"
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
// Content negotiation (JSON:API §5), client side
// ---------------------------------------------------------------------------

/**
 * Options for the client-side negotiation helpers.
 *
 * Structurally the server's `Middleware.NegotiationOptions` — deliberately the
 * same type, because the two sides have to agree: an `ext` URI the client
 * advertises must be one the server supports, or the server answers 415 / 406.
 * Pass the same value to {@link make} and `Middleware.layerWith`.
 *
 * @since 0.15.0
 * @category models
 */
export interface NegotiationOptions extends ServerNegotiationOptions {}

/**
 * The JSON:API media type this client speaks: the bare
 * `application/vnd.api+json`, or the media type carrying an `ext` parameter
 * listing the extension URIs in use.
 *
 * Built from the same definition the server's response annotations use, so the
 * syntax the client emits (one space-separated, double-quoted URI list) is
 * exactly the syntax `Middleware.acceptIsAcceptable` and
 * `Middleware.contentTypeIsAcceptable` parse. Reach for it directly when
 * something other than an `HttpClient` needs the header value — a façade
 * labelling the responses it synthesises, for instance, so its documents are
 * indistinguishable from the server's.
 *
 * This is the media type as a *header value*. To annotate a hand-rolled
 * endpoint's schema with it, reach for `MediaType.asJsonApi` instead.
 *
 * @example
 * ```ts
 * import { Atomic, Client, MEDIA_TYPE } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(Client.mediaType() === MEDIA_TYPE) // true
 * console.log(Client.mediaType({ extensions: [Atomic.EXTENSION_URI] }))
 * // application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const mediaType = (options?: NegotiationOptions): string => mediaTypeWith(options?.extensions)

const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PATCH", "PUT", "DELETE"])

/**
 * Whether a request method mutates state, and therefore carries a
 * `Content-Type` under JSON:API §5: `POST`, `PATCH`, `PUT` and `DELETE`.
 *
 * Public because it is a correctness detail, not sugar. `DELETE` is the case
 * independent implementations get inconsistently right: it usually carries no
 * body, so there is nothing to label — but the spec's negotiation rules are
 * about the *request*, not its payload, and a server that requires the label
 * will reject a `DELETE` that omits it. Calling this from both a façade and a
 * server is what stops the two disagreeing.
 *
 * The comparison is case-insensitive, so a raw `Request.method` string works
 * as well as a typed `HttpMethod`.
 *
 * @example
 * ```ts
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(Client.isMutatingMethod("GET")) // false
 * console.log(Client.isMutatingMethod("DELETE")) // true — bodyless, still labelled
 * console.log(Client.isMutatingMethod("patch")) // true — case-insensitive
 * ```
 *
 * @since 0.15.0
 * @category guards
 */
export const isMutatingMethod = (method: string): boolean => MUTATING_METHODS.has(method.toUpperCase())

// A `Content-Type` the transform may relabel: an absent one, one already at the
// JSON:API media type (possibly with different `ext` parameters), or the
// `application/json` that `HttpApiClient` stamps by default. Anything else —
// `multipart/form-data` on an upload endpoint, say — is a deliberate choice
// about the representation, not a mislabelled JSON:API body, and is left alone:
// only the label changes, never the bytes, and never the meaning.
const isRelabellable = (header: string | undefined): boolean => {
  if (header === undefined || header === "") return true
  const base = baseMediaType(header)
  return base === MEDIA_TYPE || base === "application/json"
}

/**
 * Stamps the JSON:API negotiation headers on one request, with the given
 * extensions: `Accept` on every request, and `Content-Type` on every
 * {@link isMutatingMethod mutating} one.
 *
 * {@link jsonApiHeaders} is this with no extensions.
 *
 * @example
 * ```ts
 * import { HttpClientRequest } from "effect/unstable/http"
 * import { Atomic, Client } from "@thomasfosterau/effect-jsonapi"
 *
 * const stamp = Client.jsonApiHeadersWith({ extensions: [Atomic.EXTENSION_URI] })
 * const request = stamp(HttpClientRequest.post("/operations"))
 *
 * console.log(request.headers["accept"])
 * // application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const jsonApiHeadersWith = (
  options?: NegotiationOptions
): ((request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest) => {
  const type = mediaType(options)
  return (request) => {
    const accepted = HttpClientRequest.setHeader(request, "accept", type)
    if (!isMutatingMethod(accepted.method)) return accepted
    return isRelabellable(accepted.headers["content-type"])
      ? HttpClientRequest.setHeader(accepted, "content-type", type)
      : accepted
  }
}

/**
 * Stamps the JSON:API negotiation headers on one request: `Accept` on every
 * request, and `Content-Type` on every {@link isMutatingMethod mutating} one —
 * including a bodyless `DELETE`, which otherwise carries nothing to negotiate
 * on.
 *
 * Only the label changes: the body bytes are untouched, and a request that
 * already declares a genuinely different representation (`multipart/form-data`
 * on an upload endpoint) keeps its `Content-Type`. The default
 * `application/json` an `HttpApiClient` stamps is relabelled, since that is the
 * same bytes under the wrong name.
 *
 * Use {@link jsonApiHeadersWith} when the api uses JSON:API extensions,
 * {@link transform} to apply this to a whole `HttpClient`, and {@link make} to
 * get a derived client with it already applied.
 *
 * @example
 * ```ts
 * import { HttpClientRequest } from "effect/unstable/http"
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * const read = Client.jsonApiHeaders(HttpClientRequest.get("/articles/1"))
 * console.log(read.headers["accept"]) // application/vnd.api+json
 * console.log(read.headers["content-type"]) // undefined — nothing to label
 *
 * // A bodyless DELETE is still labelled.
 * const remove = Client.jsonApiHeaders(HttpClientRequest.delete("/articles/1"))
 * console.log(remove.headers["content-type"]) // application/vnd.api+json
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const jsonApiHeaders: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest =
  jsonApiHeadersWith()

/**
 * Applies {@link jsonApiHeadersWith} to every request an `HttpClient` sends.
 *
 * {@link transform} is this with no extensions.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { HttpClient } from "effect/unstable/http"
 * import { Atomic, Client } from "@thomasfosterau/effect-jsonapi"
 *
 * const program = Effect.gen(function* () {
 *   const client = Client.transformWith({ extensions: [Atomic.EXTENSION_URI] })(
 *     yield* HttpClient.HttpClient
 *   )
 *   return yield* client.post("https://example.com/operations")
 * })
 *
 * console.log(typeof program.pipe) // the program is built, not run
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const transformWith = (
  options?: NegotiationOptions
): (<E, R>(client: HttpClient.HttpClient.With<E, R>) => HttpClient.HttpClient.With<E, R>) => {
  const headers = jsonApiHeadersWith(options)
  return (client) => HttpClient.mapRequest(client, headers)
}

/**
 * Applies {@link jsonApiHeaders} to every request an `HttpClient` sends: the
 * transform that makes an arbitrary client able to talk to a server built from
 * this package.
 *
 * Reach for it when you are assembling the client yourself — a custom
 * transport, or `HttpApiClient.makeWith` over an `HttpClient` you already
 * hold. {@link make} is this pre-applied to a client derived from an
 * `HttpApi`.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { HttpClient } from "effect/unstable/http"
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * const program = Effect.gen(function* () {
 *   const client = Client.transform(yield* HttpClient.HttpClient)
 *   return yield* client.get("https://example.com/articles/1")
 * })
 *
 * console.log(typeof program.pipe) // the program is built, not run
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const transform: <E, R>(client: HttpClient.HttpClient.With<E, R>) => HttpClient.HttpClient.With<E, R> =
  transformWith()

/**
 * Options for {@link make}: the negotiation options, plus the options
 * `HttpApiClient.make` itself takes.
 *
 * @since 0.15.0
 * @category models
 */
export interface MakeOptions extends NegotiationOptions {
  /** The base URL every request is resolved against. */
  readonly baseUrl?: URL | string | undefined
  /**
   * A further transformation of the underlying `HttpClient` — authentication
   * headers, retries, tracing. It is applied *after* the JSON:API negotiation
   * transform, so it can override the headers if it needs to.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
  /** A transformation of each endpoint's response effect. */
  readonly transformResponse?:
    | ((effect: Effect.Effect<unknown, unknown, unknown>) => Effect.Effect<unknown, unknown, unknown>)
    | undefined
}

/**
 * Derives a typed client for a JSON:API `HttpApi` that can talk to a server
 * built from the same api — `HttpApiClient.make` with {@link transform}
 * already applied.
 *
 * This is the entry point most consumers want. A plain `HttpApiClient.make`
 * client sends no `Accept` header and leaves a bodyless `DELETE` unlabelled,
 * so every client of an api defined with this package otherwise has to supply
 * the same `transformClient` by hand. Here it is the default, and an api using
 * extensions needs only `extensions` — the same value the server's
 * `Middleware.layerWith` is given.
 *
 * The `Accept` header goes on *every* request the client makes, so derive a
 * separate client for any non-JSON:API groups an api may also carry.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { FetchHttpClient } from "effect/unstable/http"
 * import { HttpApi } from "effect/unstable/httpapi"
 * import { Client, Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 * const Api = HttpApi.make("blog").add(
 *   Group.make(Article, Endpoint.get(Article), Endpoint.delete(Article))
 * )
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* Client.make(Api, { baseUrl: "https://example.com" })
 *   // Accept on the read, Accept *and* Content-Type on the bodyless delete.
 *   yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} })
 *   return yield* client.articles.delete({ params: { id: Article.Id.make("1") } })
 * }).pipe(Effect.provide(FetchHttpClient.layer))
 *
 * console.log(typeof program.pipe) // the program is built, not run
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const make = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options?: MakeOptions
): Effect.Effect<
  HttpApiClient.Client<Groups>,
  never,
  HttpClient.HttpClient | HttpApiGroup.MiddlewareClient<Groups>
> => {
  const negotiate = transformWith(options)
  return HttpApiClient.make(api, {
    baseUrl: options?.baseUrl,
    transformResponse: options?.transformResponse,
    transformClient: (client) => {
      const negotiated = negotiate(client)
      return options?.transformClient === undefined ? negotiated : options.transformClient(negotiated)
    }
  })
}

// ---------------------------------------------------------------------------
// Error documents
// ---------------------------------------------------------------------------

const WireDocument = ErrorDocumentSchema(ErrorObject)

/**
 * A decoded JSON:API error document — the shape every `ApiError` encodes to,
 * and the shape {@link decodeErrorDocument} produces.
 *
 * Built from `Document.ErrorDocument` / `Document.ErrorObject` rather than
 * `ApiError.WireDocument`: the two are the same schema, but the document
 * schemas carry no `HttpApi` binding, so decoding a body never depends on the
 * HTTP tier. The decoded value is what `ApiError.toDocument` renders.
 *
 * @since 0.15.0
 * @category models
 */
export type ErrorDocument = typeof WireDocument.Type

const decodeWireDocument = Schema.decodeUnknownOption(WireDocument)

/**
 * Best-effort decode of a response body into a JSON:API error document.
 *
 * **Never throws, and never fails.** A body that is not a conformant error
 * document — HTML from a proxy, a truncated payload, an opaque 502 from a load
 * balancer, an empty body, `null`, a document whose `errors` array is missing
 * or empty — decodes to `Option.none()`, and the caller falls back to a
 * status-only message. That matters because this runs *inside* an error path:
 * a decoder that threw would replace the server's error with its own.
 *
 * Accepts either the raw body text (parsed as JSON here) or an already-parsed
 * JSON value, so it is reachable **off the response path**: a façade that
 * synthesises responses locally and never holds an `HttpClientError` calls this
 * directly, decoding through exactly the same seam the network transport uses.
 * That is what makes a façade-served error and a network-served error for the
 * same URL indistinguishable to the client, rather than leaving it to two
 * implementations to agree. {@link errorDocument} is this same function reached
 * from a failed call.
 *
 * @example
 * ```ts
 * import { Option } from "effect"
 * import { ApiError, Client } from "@thomasfosterau/effect-jsonapi"
 *
 * // What the server sends, and what a façade renders locally, are one shape.
 * const rendered = ApiError.toDocument(new ApiError.Conflict({ detail: "Title taken" }))
 * const decoded = Client.decodeErrorDocument(JSON.stringify(rendered))
 * console.log(Option.isSome(decoded)) // true
 *
 * // A proxy's HTML, a truncated body, an empty one: no document, no throw.
 * console.log(Option.isNone(Client.decodeErrorDocument("<html>502 Bad Gateway</html>"))) // true
 * console.log(Option.isNone(Client.decodeErrorDocument('{"errors":[{"stat'))) // true
 * console.log(Option.isNone(Client.decodeErrorDocument(""))) // true
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const decodeErrorDocument = (body: unknown): Option.Option<ErrorDocument> => {
  try {
    return decodeWireDocument(typeof body === "string" ? JSON.parse(body) : body)
  } catch {
    // A body that isn't JSON at all, or a decoder that threw on a hostile
    // value: there is no document here, and this is an error path already.
    return Option.none()
  }
}

/**
 * Best-effort decode of the error document carried by a failed HTTP call.
 *
 * Reads the response body off an `HttpClientError` and hands it to
 * {@link decodeErrorDocument}, so the network path and the façade path share
 * one notion of what an error document is. Everything else — a transport
 * failure with no response at all, a cause that isn't an `HttpClientError`, a
 * body that has already been consumed — yields `Option.none()`. It never fails
 * and never throws.
 *
 * @example
 * ```ts
 * import { Effect, Option } from "effect"
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * // In a catch: `cause` is whatever the call failed with.
 * const describe = (cause: unknown) =>
 *   Effect.map(Client.errorDocument(cause), (document) =>
 *     Option.match(document, {
 *       onNone: () => "Request could not be completed",
 *       onSome: Client.errorMessage
 *     })
 *   )
 *
 * // A failure that carries no response degrades, rather than throwing.
 * console.log(Effect.runSync(describe(new Error("offline"))))
 * // Request could not be completed
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const errorDocument = (cause: unknown): Effect.Effect<Option.Option<ErrorDocument>> => {
  const response = HttpClientError.isHttpClientError(cause) ? cause.response : undefined
  if (response === undefined) return Effect.succeed(Option.none())
  return response.text.pipe(
    Effect.map(decodeErrorDocument),
    // The body may be unreadable (already consumed, a broken stream): that is
    // still "no document", never a second failure on top of the first.
    Effect.catchCause(() => Effect.succeed(Option.none<ErrorDocument>()))
  )
}

/**
 * The default message {@link errorMessage} falls back to when an error
 * document carries neither a `detail` nor a `title`.
 *
 * @since 0.15.0
 * @category constants
 */
export const DEFAULT_ERROR_MESSAGE = "Request could not be completed"

/**
 * The first human-readable message in an error document: the first error
 * object's `detail`, else its `title`, else {@link DEFAULT_ERROR_MESSAGE}.
 *
 * The spec's own ordering — `detail` is specific to this occurrence, `title` is
 * constant across occurrences — so the most informative message available wins.
 *
 * @example
 * ```ts
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(
 *   Client.errorMessage({
 *     errors: [{ status: "404", title: "Not Found", detail: "Article 1 not found" }]
 *   })
 * ) // Article 1 not found
 *
 * console.log(Client.errorMessage({ errors: [{ status: "404", title: "Not Found" }] }))
 * // Not Found
 *
 * console.log(Client.errorMessage({ errors: [{ status: "503" }] }))
 * // Request could not be completed
 * ```
 *
 * @since 0.15.0
 * @category accessors
 */
export const errorMessage = (document: ErrorDocument): string => {
  const first = document.errors[0] as ErrorDocument["errors"][number] | undefined
  return first?.detail ?? first?.title ?? DEFAULT_ERROR_MESSAGE
}
