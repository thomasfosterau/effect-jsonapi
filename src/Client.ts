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
 * ```ts skip-type-checking
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
 * import { FetchHttpClient } from "effect/http"
 * import { HttpApi } from "effect/http-api"
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
import { Array as Arr, Effect, Option, Order, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import type { HttpApi, HttpApiGroup } from "effect/http-api";
import { HttpApiClient } from "effect/http-api";
import type { JsonApiObject, Wire } from "./Document.js";
import { ErrorDocument as ErrorDocumentSchema, ErrorObject } from "./Document.js";
import type { Pair } from "./internal/canonical.js";
import { serialise, withPagePairs } from "./internal/canonical.js";
import { baseMediaType, MEDIA_TYPE, mediaTypeWith } from "./internal/media.js";
import type { NegotiationOptions as ServerNegotiationOptions } from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import type {
  Any,
  IncludedFor,
  IncludePath,
  IncludePathsTo,
  RelationshipName,
  Target,
} from "./Resource.js";
import { relationships } from "./Resource.js";

/**
 * The minimal shape of a compound document value.
 *
 * @since 0.1.0
 * @category models
 */
export interface AnyDocument {
  readonly included?: ReadonlyArray<unknown> | undefined;
}

/**
 * A document with its `included` member narrowed to the given resources'
 * decoded types.
 *
 * @since 0.1.0
 * @category type-level
 */
export type NarrowedDocument<Doc, Included extends Any> = Omit<Doc, "included"> & {
  readonly included?: ReadonlyArray<Included["Type"]>;
};

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
    include: Paths,
  ): <Doc extends AnyDocument, E, Req>(
    effect: Effect.Effect<Doc, E, Req>,
  ) => Effect.Effect<NarrowedDocument<Doc, IncludedFor<R, Paths>>, E, Req>;
  <R extends Any, const Paths extends ReadonlyArray<IncludePath<R>>, Doc extends AnyDocument>(
    resource: R,
    include: Paths,
    document: Doc,
  ): NarrowedDocument<Doc, IncludedFor<R, Paths>>;
} = ((...args: ReadonlyArray<unknown>) =>
  args.length >= 3
    ? // data-first: the document itself
      args[2]
    : // data-last: an identity function over the effect
      <Doc extends AnyDocument, E, Req>(effect: Effect.Effect<Doc, E, Req>) => effect) as never;

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
export const mediaType = (options?: NegotiationOptions): string =>
  mediaTypeWith(options?.extensions);

const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PATCH", "PUT", "DELETE"]);

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
export const isMutatingMethod = (method: string): boolean =>
  MUTATING_METHODS.has(method.toUpperCase());

// A `Content-Type` the transform may relabel: an absent one, one already at the
// JSON:API media type (possibly with different `ext` parameters), or the
// `application/json` that `HttpApiClient` stamps by default. Anything else —
// `multipart/form-data` on an upload endpoint, say — is a deliberate choice
// about the representation, not a mislabelled JSON:API body, and is left alone:
// only the label changes, never the bytes, and never the meaning.
const isRelabellable = (header: string | undefined): boolean => {
  if (header === undefined || header === "") return true;
  const base = baseMediaType(header);
  return base === MEDIA_TYPE || base === "application/json";
};

/**
 * Stamps the JSON:API negotiation headers on one request, with the given
 * extensions: `Accept` on every request, and `Content-Type` on every
 * {@link isMutatingMethod mutating} one.
 *
 * {@link jsonApiHeaders} is this with no extensions.
 *
 * @example
 * ```ts
 * import { HttpClientRequest } from "effect/http"
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
  options?: NegotiationOptions,
): ((request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest) => {
  const type = mediaType(options);
  return (request) => {
    const accepted = HttpClientRequest.setHeader(request, "accept", type);
    if (!isMutatingMethod(accepted.method)) return accepted;
    return isRelabellable(accepted.headers["content-type"])
      ? HttpClientRequest.setHeader(accepted, "content-type", type)
      : accepted;
  };
};

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
 * import { HttpClientRequest } from "effect/http"
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
export const jsonApiHeaders: (
  request: HttpClientRequest.HttpClientRequest,
) => HttpClientRequest.HttpClientRequest = jsonApiHeadersWith();

/**
 * Applies {@link jsonApiHeadersWith} to every request an `HttpClient` sends.
 *
 * {@link transform} is this with no extensions.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { HttpClient } from "effect/http"
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
  options?: NegotiationOptions,
): (<E, R>(client: HttpClient.HttpClient.With<E, R>) => HttpClient.HttpClient.With<E, R>) => {
  const headers = jsonApiHeadersWith(options);
  return (client) => HttpClient.mapRequest(client, headers);
};

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
 * import { HttpClient } from "effect/http"
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
export const transform: <E, R>(
  client: HttpClient.HttpClient.With<E, R>,
) => HttpClient.HttpClient.With<E, R> = transformWith();

/**
 * Options for {@link make}: the negotiation options, plus the options
 * `HttpApiClient.make` itself takes.
 *
 * @since 0.15.0
 * @category models
 */
export interface MakeOptions extends NegotiationOptions {
  /** The base URL every request is resolved against. */
  readonly baseUrl?: URL | string | undefined;
  /**
   * A further transformation of the underlying `HttpClient` — authentication
   * headers, retries, tracing. It is applied *after* the JSON:API negotiation
   * transform, so it can override the headers if it needs to.
   */
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined;
  /** A transformation of each endpoint's response effect. */
  readonly transformResponse?:
    | ((
        effect: Effect.Effect<unknown, unknown, unknown>,
      ) => Effect.Effect<unknown, unknown, unknown>)
    | undefined;
  /**
   * Fail every call the server answered with an error response as a decoded
   * {@link ErrorResponse} — its status, a readable message and the JSON:API
   * error document when the body carried one — instead of the raw
   * `HttpClientError` ({@link failWithErrorResponse}, applied before
   * `transformResponse`). Transport faults carrying no response pass through
   * unchanged.
   *
   * The generated client's *static* error type is `HttpApiClient`'s and
   * cannot name the class, so `Effect.catchTag("ErrorResponse", …)` does not
   * type-check; match at runtime with {@link isErrorResponse}.
   *
   * @since 0.16.0
   */
  readonly decodeErrors?: boolean | undefined;
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
 * import { FetchHttpClient } from "effect/http"
 * import { HttpApi } from "effect/http-api"
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
  options?: MakeOptions,
): Effect.Effect<
  HttpApiClient.Client<Groups>,
  never,
  HttpClient.HttpClient | HttpApiGroup.MiddlewareClient<Groups>
> => {
  const negotiate = transformWith(options);
  const transformResponse = options?.transformResponse;
  return HttpApiClient.make(api, {
    baseUrl: options?.baseUrl,
    transformResponse:
      options?.decodeErrors === true
        ? (effect) => {
            const decoded = failWithErrorResponse(effect);
            return transformResponse === undefined ? decoded : transformResponse(decoded);
          }
        : transformResponse,
    transformClient: (client) => {
      const negotiated = negotiate(client);
      return options?.transformClient === undefined
        ? negotiated
        : options.transformClient(negotiated);
    },
  });
};

// ---------------------------------------------------------------------------
// Error documents
// ---------------------------------------------------------------------------

const WireDocument = ErrorDocumentSchema(ErrorObject);

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
export type ErrorDocument = typeof WireDocument.Type;

const decodeWireDocument = Schema.decodeUnknownOption(WireDocument);

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
 * Accepts the raw body text (parsed as JSON here), an already-parsed JSON
 * value or an {@link ErrorDocument} already in hand (what
 * `ApiError.toDocument` renders), so it is reachable **off the response
 * path**: a façade that
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
export const decodeErrorDocument = (
  body: string | Schema.Json | ErrorDocument,
): Option.Option<ErrorDocument> =>
  // A body that isn't JSON at all, or a decoder that threw on a hostile
  // value, lifts to `None`: there is no document here, and this is an error
  // path already.
  Option.flatten(
    Option.liftThrowable(() =>
      decodeWireDocument(typeof body === "string" ? JSON.parse(body) : body),
    )(),
  );

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
  const response = HttpClientError.isHttpClientError(cause) ? cause.response : undefined;
  if (response === undefined) return Effect.succeed(Option.none());
  return response.text.pipe(
    // The body may be unreadable (already consumed, a broken stream): that is
    // still "no document", never a second failure on top of the first.
    Effect.matchCause({
      onFailure: () => Option.none<ErrorDocument>(),
      onSuccess: decodeErrorDocument,
    }),
  );
};

/**
 * The default message {@link errorMessage} falls back to when an error
 * document carries neither a `detail` nor a `title`.
 *
 * @since 0.15.0
 * @category constants
 */
export const DEFAULT_ERROR_MESSAGE = "Request could not be completed";

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
  const first = document.errors[0] as ErrorDocument["errors"][number] | undefined;
  return first?.detail ?? first?.title ?? DEFAULT_ERROR_MESSAGE;
};

// ---------------------------------------------------------------------------
// Error responses
// ---------------------------------------------------------------------------

/**
 * A call the server answered with an error response, decoded: the HTTP
 * status, a readable message (the document's first `detail` / `title`, or
 * `Request failed (<status>)` when the body carried no document) and the
 * JSON:API error document when there was one.
 *
 * The client-side counterpart of `ServerErrors.JsonapiError`, and the shape
 * an application's SSR boundary and form actions match on.
 *
 * @since 0.16.0
 * @category errors
 */
export class ErrorResponse extends Schema.TaggedError<ErrorResponse>()("ErrorResponse", {
  status: Schema.Number,
  message: Schema.String,
  document: Schema.Option(WireDocument),
}) {}

/**
 * Whether a value is an {@link ErrorResponse}.
 *
 * @since 0.16.0
 * @category guards
 */
export const isErrorResponse = (u: unknown): u is ErrorResponse => u instanceof ErrorResponse;

/**
 * The {@link ErrorResponse} behind a failed call, when the failure is an
 * `HttpClientError` carrying a response: its status, and its body decoded
 * through {@link errorDocument}. `none` for anything else — a transport
 * fault, a decode failure, a value that is no `HttpClientError` at all — so
 * a defect keeps its original cause.
 *
 * @example
 * ```ts
 * import { Effect, Option } from "effect"
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * // a transport fault carries no response, so there is no error response to read
 * console.log(Effect.runSync(Client.toErrorResponse(new Error("connection reset"))))
 * // → { _id: "Option", _tag: "None" }
 * ```
 *
 * @since 0.16.0
 * @category errors
 */
export const toErrorResponse = (cause: unknown): Effect.Effect<Option.Option<ErrorResponse>> => {
  if (!HttpClientError.isHttpClientError(cause) || cause.response === undefined) {
    return Effect.succeed(Option.none());
  }
  const status = cause.response.status;
  return errorDocument(cause).pipe(
    Effect.map((document) =>
      Option.some(
        new ErrorResponse({
          status,
          message: Option.match(document, {
            onNone: () => `Request failed (${status})`,
            onSome: errorMessage,
          }),
          document,
        }),
      ),
    ),
  );
};

/**
 * Re-fails a call the server answered with an error response as its decoded
 * {@link ErrorResponse}; every other failure passes through unchanged. What
 * {@link make}'s `decodeErrors` applies to every endpoint.
 *
 * @since 0.16.0
 * @category combinators
 */
export const failWithErrorResponse = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ErrorResponse, R> =>
  Effect.catch(effect, (cause) =>
    toErrorResponse(cause).pipe(
      Effect.flatMap((response): Effect.Effect<never, E | ErrorResponse> =>
        Option.match(response, {
          onNone: () => Effect.fail(cause),
          onSome: (decoded) => Effect.fail(decoded),
        }),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Documents as the client reads them
// ---------------------------------------------------------------------------

/**
 * One member of a compound document's `included` array as the client reads
 * it — a resource of some type resolved by an `?include=` walk, typed
 * structurally because the type varies per include path.
 *
 * @since 0.16.0
 * @category models
 */
export interface IncludedResource {
  readonly type: string;
  readonly id: string;
  readonly attributes?: { readonly [key: string]: unknown } | undefined;
  readonly relationships?: { readonly [key: string]: unknown } | undefined;
  readonly links?: { readonly [key: string]: unknown } | undefined;
  readonly meta?: { readonly [key: string]: unknown } | undefined;
}

/**
 * The top-level `meta` and `links` members as the client reads them: open
 * records, since the document schema declares them so.
 *
 * @since 0.16.0
 * @category models
 */
export interface DocumentMembers {
  readonly meta?: { readonly [key: string]: unknown } | undefined;
  readonly links?: { readonly [key: string]: unknown } | undefined;
  readonly jsonapi?: typeof JsonApiObject.Type | undefined;
}

/**
 * A single-resource document for `R` as the client reads it — the wire form
 * (`Document.Wire`: string links), `included` narrowed to `Included` when
 * the endpoint's include targets are a known union.
 *
 * @since 0.16.0
 * @category models
 */
export interface ResourceDocument<R, Included = IncludedResource> extends DocumentMembers {
  readonly data: Wire<R>;
  readonly included?: ReadonlyArray<Included> | undefined;
}

/**
 * A collection document for `R` as the client reads it.
 *
 * @since 0.16.0
 * @category models
 */
export interface CollectionDocument<R, Included = IncludedResource> extends DocumentMembers {
  readonly data: ReadonlyArray<Wire<R>>;
  readonly included?: ReadonlyArray<Included> | undefined;
}

/**
 * `meta.totalCount` off a collection document (or its `meta` member) — the
 * unpaged count of rows matching the request that a server's collection
 * assembler reports. `0` when absent or not a number.
 *
 * @example
 * ```ts
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(Client.readTotalCount({ data: [], meta: { totalCount: 42 } }), Client.readTotalCount({ data: [] }))
 * // → 42 0
 * ```
 *
 * @since 0.16.0
 * @category accessors
 */
export const readTotalCount = (
  source:
    | {
        readonly meta?: { readonly [key: string]: unknown } | undefined;
        readonly [member: string]: unknown;
      }
    | undefined,
): number => {
  const totalCount = source?.meta?.["totalCount"];
  return typeof totalCount === "number" ? totalCount : 0;
};

/**
 * Whether an offset-paginated window has a next page, from the real unpaged
 * `totalCount` a list read reports alongside its window. Correct at the
 * boundary a `data.length === limit` heuristic gets wrong: a collection whose
 * size is an exact multiple of `limit` reports `offset + limit === totalCount`
 * here rather than advertising a next page that renders empty.
 *
 * @example
 * ```ts
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(Client.hasNextPage(0, 10, 25), Client.hasNextPage(20, 10, 25), Client.hasNextPage(10, 10, 20))
 * // → true false false
 * ```
 *
 * @since 0.16.0
 * @category accessors
 */
export const hasNextPage = (offset: number, limit: number, totalCount: number): boolean =>
  offset + limit < totalCount;

// ---------------------------------------------------------------------------
// Call-site inputs
// ---------------------------------------------------------------------------

/**
 * Loose call-site input for a wrapper: every field optional and explicitly
 * `undefined`-tolerant, matching how a page builds inputs
 * (`{ limit: x ?? 50, q: maybeUndefined }`). {@link decodeInput} strips the
 * `undefined` members and decodes through the schema, so required fields and
 * bounds are still enforced.
 *
 * @since 0.16.0
 * @category models
 */
export type LooseInput<T> = { readonly [K in keyof T]?: T[K] | undefined };

/**
 * Drops explicitly-`undefined` members, so an absent key and a key set to
 * `undefined` decode alike.
 *
 * @since 0.16.0
 * @category utils
 */
export const stripUndefined = <T extends object>(
  input: T,
): { readonly [K in keyof T]: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as {
    readonly [K in keyof T]: Exclude<T[K], undefined>;
  };

/**
 * A decoder for a loose call-site input: strips `undefined` members, then
 * decodes through `schema` — the flat list input with its decoding defaults,
 * a command input, an id.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Client, FlatQuery } from "@thomasfosterau/effect-jsonapi"
 *
 * const ListPeople = FlatQuery.listInput({ maxLimit: 100 }, { q: Schema.optionalKey(Schema.String) })
 * const decode = Client.decodeInput(ListPeople)
 * console.log(Effect.runSync(decode({ limit: 5, q: undefined })))
 * // → { offset: 0, limit: 5 }
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const decodeInput =
  <S extends Schema.Top>(schema: S) =>
  (
    input: LooseInput<S["Encoded"]>,
  ): Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]> =>
    Schema.decodeUnknownEffect(
      schema as unknown as Schema.Codec<S["Type"], S["Encoded"], S["DecodingServices"]>,
    )(stripUndefined(input as object));

// ---------------------------------------------------------------------------
// Hydrating `included`
// ---------------------------------------------------------------------------

/**
 * A document's `included` member indexed by `(type, id)` — the key a
 * relationship ref is matched on. Build it once per document and resolve
 * each arm through it, so a resource with five relationships is five lookups
 * per ref rather than five scans of the whole set.
 *
 * @since 0.16.0
 * @category models
 */
export type IncludedIndex = ReadonlyMap<string, IncludedResource>;

const refKey = (ref: { readonly type: string; readonly id: string }): string =>
  `${ref.type}:${ref.id}`;

/**
 * Indexes a document's `included` member for ref lookup; an absent member
 * indexes to nothing.
 *
 * @since 0.16.0
 * @category constructors
 */
export const indexIncluded = (
  included: ReadonlyArray<IncludedResource> | undefined,
): IncludedIndex => new Map((included ?? []).map((resource) => [refKey(resource), resource]));

/**
 * The minimum shape a resource value exposes for its linkage to be read: a
 * decoded resource's `relationships` member, structurally.
 *
 * @since 0.16.0
 * @category models
 */
export interface LinkedResource {
  readonly relationships?: { readonly [key: string]: unknown } | undefined;
}

/** The refs one relationship key carries: `[]` for absent, `null` or empty linkage. */
const refsOf = (
  resource: LinkedResource | undefined,
  key: string,
): ReadonlyArray<{ readonly type: string; readonly id: string }> => {
  const linkage = resource?.relationships?.[key];
  if (linkage === null || typeof linkage !== "object") return [];
  const data = (linkage as { readonly data?: unknown }).data;
  if (data === null || data === undefined || typeof data !== "object") return [];
  return (Array.isArray(data) ? data : [data]) as ReadonlyArray<{
    readonly type: string;
    readonly id: string;
  }>;
};

const lookup = (
  refs: ReadonlyArray<{ readonly type: string; readonly id: string }>,
  index: IncludedIndex,
): ReadonlyArray<IncludedResource> =>
  refs.flatMap((ref) => {
    const found = index.get(refKey(ref));
    return found === undefined ? [] : [found];
  });

/**
 * What {@link related} resolves a relationship to: the target's decoded value
 * as an `Option` for a to-one relationship, an array for a to-many.
 *
 * @since 0.16.0
 * @category type-level
 */
export type Related<R extends Any, K> =
  R["relationships"][K & keyof R["relationships"]] extends Relationship.ToOne<Any>
    ? Option.Option<Target<R, K>["Type"]>
    : ReadonlyArray<Target<R, K>["Type"]>;

/**
 * The resource definition at the **end** of a dotted include path — what
 * {@link walk} resolves to. (`IncludedFor` is the union of every hop, which
 * is what a document's `included` carries; this is the last hop alone.)
 *
 * @since 0.16.0
 * @category type-level
 */
export type PathTarget<R extends Any, Path> = Path extends `${infer Head}.${infer Rest}`
  ? PathTarget<Target<R, Head>, Rest>
  : Target<R, Path>;

/**
 * Resolves one relationship of a resource value through the document's
 * `included` index, typed by the resource definition: an `Option` of the
 * target for a to-one relationship, an array in linkage order for a to-many.
 * A ref that didn't resolve — a target the include walk didn't hoist, or one
 * the viewer may not see — is `none` / skipped, never a failure.
 *
 * @example
 * ```ts
 * import { Option, Schema } from "effect"
 * import { Client, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person), reviewers: Relationship.many(() => Person) }
 * })
 * const document = {
 *   data: {
 *     type: "articles", id: "1", attributes: { title: "Hi" },
 *     relationships: { author: { data: { type: "people", id: "9" } }, reviewers: { data: [{ type: "people", id: "2" }] } }
 *   },
 *   included: [{ type: "people", id: "9", attributes: { name: "Ada" } }]
 * }
 * const index = Client.indexIncluded(document.included)
 * const author = Client.related(Article, document.data, "author", index)
 * console.log(Option.map(author, (person) => person.attributes.name))
 * // → { _id: "Option", _tag: "Some", value: "Ada" }
 * console.log(Client.related(Article, document.data, "reviewers", index))
 * // → []
 * ```
 *
 * @since 0.16.0
 * @category accessors
 */
export const related = <R extends Any, const K extends RelationshipName<R>>(
  resource: R,
  data: LinkedResource | undefined,
  key: K,
  index: IncludedIndex,
): Related<R, K> => {
  const resolved = lookup(refsOf(data, key), index);
  const descriptor = relationships(resource)[key] as Relationship.Descriptor | undefined;
  // The values in the index are the target's decoded resources; the
  // definition says which type each key resolves to.
  return (
    descriptor !== undefined && Relationship.isToOne(descriptor)
      ? Option.fromUndefinedOr(resolved[0])
      : resolved
  ) as Related<R, K>;
};

/**
 * Resolves a dotted include path — the two-hop `authors.contributor` shape,
 * where the middle resource is a relator carrying the credit's shape rather
 * than a name — hop by hop through the index, returning the resources at
 * the **end** of the path in linkage order, deduplicated. A hop that doesn't
 * resolve contributes nothing.
 *
 * @since 0.16.0
 * @category accessors
 */
export const walk = <R extends Any, const P extends IncludePathsTo<R, 3>>(
  _resource: R,
  data: LinkedResource | undefined,
  path: P,
  index: IncludedIndex,
): ReadonlyArray<PathTarget<R, P>["Type"]> => {
  let level: ReadonlyArray<LinkedResource | undefined> = [data];
  for (const segment of path.split(".")) {
    const seen = new Set<string>();
    level = level.flatMap((parent) =>
      lookup(refsOf(parent, segment), index).filter((found) => {
        const key = refKey(found);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  }
  return level as ReadonlyArray<PathTarget<R, P>["Type"]>;
};

/**
 * The hydrated view of one document: its `included` indexed once, and
 * {@link related} / {@link walk} bound to the resource definition and the
 * index, so a component resolves each arm with a key or a path alone.
 *
 * @example
 * ```ts
 * import { Option, Schema } from "effect"
 * import { Client, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } })
 * const Credit = Resource.make("credits", {
 *   attributes: { role: Schema.String },
 *   relationships: { contributor: Relationship.one(() => Person) }
 * })
 * const Book = Resource.make("books", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: { authors: Relationship.many(() => Credit), publisher: Relationship.optional(() => Person) }
 * })
 * const document = {
 *   data: {
 *     type: "books", id: "b1", attributes: { title: "Dune" },
 *     relationships: {
 *       authors: { data: [{ type: "credits", id: "c1" }, { type: "credits", id: "c2" }] },
 *       publisher: { data: null }
 *     }
 *   },
 *   included: [
 *     { type: "credits", id: "c1", attributes: { role: "author" }, relationships: { contributor: { data: { type: "people", id: "p1" } } } },
 *     { type: "credits", id: "c2", attributes: { role: "author" }, relationships: { contributor: { data: { type: "people", id: "p1" } } } },
 *     { type: "people", id: "p1", attributes: { name: "Frank Herbert" } }
 *   ]
 * }
 * const book = Client.hydrate(Book, document)
 * console.log(book.walk("authors.contributor").map((person) => person.attributes.name))
 * // → [ "Frank Herbert" ]
 * console.log(Option.isNone(book.related("publisher")))
 * // → true
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const hydrate = <R extends Any>(
  resource: R,
  document: {
    readonly data: LinkedResource | null;
    readonly included?: ReadonlyArray<IncludedResource> | undefined;
  },
): {
  readonly index: IncludedIndex;
  readonly related: <const K extends RelationshipName<R>>(key: K) => Related<R, K>;
  readonly walk: <const P extends IncludePathsTo<R, 3>>(
    path: P,
  ) => ReadonlyArray<PathTarget<R, P>["Type"]>;
} => {
  const index = indexIncluded(document.included);
  const data = document.data ?? undefined;
  return {
    index,
    related: (key) => related(resource, data, key, index),
    walk: (path) => walk(resource, data, path, index),
  };
};

// ---------------------------------------------------------------------------
// Page cursors
// ---------------------------------------------------------------------------

/**
 * An offset / limit page position — the `page[offset]` / `page[limit]` pair
 * a list page carries in its own URL and passes through to the api.
 *
 * @since 0.16.0
 * @category models
 */
export interface PageCursor {
  readonly offset: number;
  readonly limit: number;
}

/**
 * Options of {@link readPageCursor} and {@link pageHref}.
 *
 * @since 0.16.0
 * @category models
 */
export interface PageCursorOptions {
  /**
   * The bracket prefix. Defaults to `"page"`; a page holding two
   * independently paginated lists names one prefix per list so their
   * cursors don't collide.
   */
  readonly key?: string | undefined;
  /** The limit read when the URL names none, or names one that is malformed. Defaults to `50`. */
  readonly defaultLimit?: number | undefined;
  /** The largest limit honoured; a larger one is clamped. Defaults to `100`. */
  readonly maxLimit?: number | undefined;
}

const nonNegativeInt = (raw: string | null): number | undefined => {
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const searchParamsOf = (source: URL | URLSearchParams | string): URLSearchParams =>
  source instanceof URLSearchParams
    ? source
    : source instanceof URL
      ? source.searchParams
      : new URL(source, "http://cursor.invalid").searchParams;

/**
 * Reads a page cursor off a URL, its search params or a query string:
 * `<key>[offset]` (default `0`) and `<key>[limit]` (default `defaultLimit`),
 * each falling back to its default when absent or malformed rather than
 * failing the page — a mistyped URL should still render a list — and the
 * limit clamped to `[1, maxLimit]`, so a page never hands a user-controlled
 * number onward unbounded.
 *
 * @example
 * ```ts
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(Client.readPageCursor(new URL("https://example.test/people?page[offset]=20&page[limit]=10")))
 * // → { offset: 20, limit: 10 }
 * console.log(Client.readPageCursor("?page[limit]=999&page[offset]=-1", { defaultLimit: 24 }))
 * // → { offset: 0, limit: 100 }
 * ```
 *
 * @since 0.16.0
 * @category accessors
 */
export const readPageCursor = (
  source: URL | URLSearchParams | string,
  options?: PageCursorOptions,
): PageCursor => {
  const key = options?.key ?? "page";
  const params = searchParamsOf(source);
  const limit = nonNegativeInt(params.get(`${key}[limit]`)) ?? options?.defaultLimit ?? 50;
  const offset = nonNegativeInt(params.get(`${key}[offset]`)) ?? 0;
  return { offset, limit: Math.min(Math.max(limit, 1), options?.maxLimit ?? 100) };
};

/**
 * The href for `cursor` from `base` (a path, optionally with a query string
 * and fragment): the cursor's two parameters replaced, every other parameter
 * preserved. A relative `base` yields a relative href.
 *
 * @example
 * ```ts
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(Client.pageHref("/people?filter[q]=ada&page[offset]=0", { offset: 10, limit: 10 }))
 * // → /people?filter[q]=ada&page[offset]=10&page[limit]=10
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const pageHref = (
  base: string,
  cursor: PageCursor,
  options?: Pick<PageCursorOptions, "key">,
): string => {
  const key = options?.key ?? "page";
  const url = new URL(base, "http://cursor.invalid");
  url.searchParams.set(`${key}[offset]`, String(cursor.offset));
  url.searchParams.set(`${key}[limit]`, String(cursor.limit));
  return `${url.pathname}${url.search}${url.hash}`;
};

/**
 * The page's own query keys, as it has them: a blank or absent value means
 * "not applied" and is left off the link rather than written as an empty key.
 *
 * @since 0.16.0
 * @category models
 */
export type PageFilters = { readonly [key: string]: string | undefined };

const appliedFilters = (filters: PageFilters): Array<[string, string]> =>
  Object.entries(filters).flatMap(([key, value]): Array<[string, string]> =>
    value === undefined || value === "" ? [] : [[key, value]],
  );

/**
 * An `href(offset)` builder for a public index page: the bare path for the
 * first page (so the canonical URL and the "page 1" link agree) and
 * `?page[offset]=` plus the page's filters beyond it. A filtered list that
 * silently drops its filter on page 2 is not a filtered list.
 *
 * @example
 * ```ts
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * const href = Client.filteredPageHref("/people", { q: "ada", role: "" })
 * console.log(href(0), href(24))
 * // → /people?q=ada /people?page%5Boffset%5D=24&q=ada
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const filteredPageHref =
  (path: string, filters: PageFilters = {}, options?: Pick<PageCursorOptions, "key">) =>
  (offset: number): string => {
    const key = options?.key ?? "page";
    const cursor: Array<[string, string]> = offset > 0 ? [[`${key}[offset]`, String(offset)]] : [];
    const query = new URLSearchParams([...cursor, ...appliedFilters(filters)]).toString();
    return query === "" ? path : `${path}?${query}`;
  };

/**
 * An `href(offset)` builder for a page that states the whole window in its
 * URL (`page[limit]` and `page[offset]`, the first page included) plus the
 * page's filters — so an operator can widen it from the address bar.
 *
 * @since 0.16.0
 * @category constructors
 */
export const windowedPageHref =
  (
    path: string,
    limit: number,
    filters: PageFilters = {},
    options?: Pick<PageCursorOptions, "key">,
  ) =>
  (offset: number): string => {
    const key = options?.key ?? "page";
    const cursor: Array<[string, string]> = [
      [`${key}[limit]`, String(limit)],
      [`${key}[offset]`, String(offset)],
    ];
    const query = new URLSearchParams([...cursor, ...appliedFilters(filters)]).toString();
    return `${path}?${query}`;
  };

/**
 * The href for `cursor` carrying the request's **canonical** query — the
 * pairs `Query.canonicalPairs(listQuery)(query)` produced, in the order it
 * produced them (`include`, `fields[*]`, `filter[*]`, `sort`, then the
 * cursor) — with the request's own `page[*]` pairs replaced by `cursor`. The
 * spelling a server's collection links use: two equal queries give one href,
 * whatever the wire spelling they came from, which is what makes the href
 * usable as a cache key.
 *
 * @example
 * ```ts
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * const pairs = [["include", "birthPlace"], ["filter[q]", "ada"], ["page[offset]", "0"], ["page[limit]", "10"]] as const
 * console.log(Client.canonicalPageHref("/people", pairs, { offset: 10, limit: 10 }))
 * // → /people?include=birthPlace&filter[q]=ada&page[offset]=10&page[limit]=10
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const canonicalPageHref = (
  path: string,
  query: ReadonlyArray<Pair>,
  cursor: PageCursor,
): string => {
  const pairs = withPagePairs(query, [
    ["page[offset]", String(cursor.offset)],
    ["page[limit]", String(cursor.limit)],
  ]);
  return `${path}?${serialise(pairs)}`;
};

/**
 * One entry in a rendered page window.
 *
 * @since 0.16.0
 * @category models
 */
export type PageWindowItem =
  | {
      readonly kind: "page";
      /** 1-based page number. */
      readonly page: number;
      readonly offset: number;
      readonly current: boolean;
    }
  | { readonly kind: "gap"; readonly after: number };

/**
 * The page-window arithmetic behind a pagination control.
 *
 * @since 0.16.0
 * @category models
 */
export interface PageWindow {
  /** 1-based current page. */
  readonly page: number;
  /** Total pages; at least 1. */
  readonly pageCount: number;
  /** 1-based index of the first row shown, or 0 when there are no rows. */
  readonly from: number;
  /** 1-based index of the last row shown, or 0 when there are no rows. */
  readonly to: number;
  /** The previous page's offset, when there is one. */
  readonly prev: Option.Option<number>;
  /** The next page's offset, when there is one. */
  readonly next: Option.Option<number>;
  /** First page, last page, and `siblings` either side of the current page, with gaps. */
  readonly items: ReadonlyArray<PageWindowItem>;
}

/**
 * The window of page links to render around the current position: the first
 * and last pages always, plus `siblings` pages either side of the current
 * one, with a gap marker wherever the sequence skips. Pure, so the component
 * that renders it is markup only.
 *
 * @example
 * ```ts
 * import { Client } from "@thomasfosterau/effect-jsonapi"
 *
 * const window = Client.pageWindow({ offset: 40, limit: 10 }, 95)
 * console.log(window.page, window.pageCount, window.from, window.to)
 * // → 5 10 41 50
 * console.log(window.items.map((item) => (item.kind === "gap" ? "…" : item.page)))
 * // → [ 1, "…", 4, 5, 6, "…", 10 ]
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const pageWindow = (cursor: PageCursor, total: number, siblings = 1): PageWindow => {
  const limit = Math.max(1, cursor.limit);
  const offset = Math.max(0, cursor.offset);
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total) / limit));
  const current = Math.min(pageCount, Math.floor(offset / limit) + 1);
  const wanted = [
    ...new Set(
      Arr.sort(
        [
          1,
          pageCount,
          ...Array.from({ length: siblings * 2 + 1 }, (_, i) => current - siblings + i),
        ].filter((n) => n >= 1 && n <= pageCount),
        Order.Number,
      ),
    ),
  ];
  const items = wanted.flatMap((n, i): ReadonlyArray<PageWindowItem> => {
    const entry: PageWindowItem = {
      kind: "page",
      page: n,
      offset: (n - 1) * limit,
      current: n === current,
    };
    const previous = i > 0 ? (wanted[i - 1] ?? n) : n;
    return n - previous > 1 ? [{ kind: "gap", after: previous }, entry] : [entry];
  });
  return {
    page: current,
    pageCount,
    from: total > 0 ? (current - 1) * limit + 1 : 0,
    to: total > 0 ? Math.min(total, current * limit) : 0,
    prev: current > 1 ? Option.some((current - 2) * limit) : Option.none(),
    next: current < pageCount ? Option.some(current * limit) : Option.none(),
    items,
  };
};
