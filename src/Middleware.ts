/**
 * JSON:API protocol middleware.
 *
 * Two `HttpApiMiddleware` services enforce the parts of the spec that live
 * outside schemas:
 *
 *   - {@link ContentNegotiation} — JSON:API §5 content negotiation:
 *       - a request `Content-Type: application/vnd.api+json` carrying media
 *         type parameters other than `ext` / `profile` (or unsupported
 *         extension URIs) → 415 Unsupported Media Type
 *       - an `Accept` header in which every instance of the JSON:API media
 *         type carries such parameters → 406 Not Acceptable
 *   - {@link SchemaErrors} — converts request validation failures (malformed
 *     query parameters, payloads, path parameters) into spec-compliant
 *     JSON:API 400 error documents instead of the default HttpApi error shape:
 *     an error object per reported issue, each with a `detail` and a `source`
 *     naming the offending `parameter` (`filter[age][gt]`, `page[limit]`),
 *     `pointer` (`/data/attributes/title`) or `header`. HttpApi decodes each
 *     request part with the default parse options (`errors: "first"`), so a
 *     part yields one error object — except the `filter` family, whose codec
 *     reports every offending key together.
 *
 * Both middlewares are attached automatically by the `Endpoint` constructors,
 * so any `HttpApi` containing JSON:API endpoints will fail to build (at the
 * type level) until {@link layer} is provided — compliance cannot be
 * forgotten.
 *
 * Both are also usable **outside** those constructors, for hosts that own the
 * URL themselves: {@link negotiate} runs the §5 rules over plain headers and
 * {@link schemaError} builds the request-validation 400 (and
 * {@link schemaErrorDocument} the source-bearing document from the decoding
 * failure itself), both rendered with `ApiError.toDocument`. And for an api
 * built from the constructors whose host has already negotiated,
 * {@link layerHostNegotiated} satisfies the endpoints' negotiation
 * requirement without running §5 twice.
 *
 * @since 0.1.0
 */
import type { Schema } from "effect"
import { Effect, Layer, SchemaIssue } from "effect"
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { BadRequest, NotAcceptable, toDocument, UnsupportedMediaType, type WireDocument } from "./ApiError.js"
import type { ErrorSource } from "./Document.js"
import { MEDIA_TYPE } from "./internal/media.js"

// ---------------------------------------------------------------------------
// Content negotiation predicates (JSON:API §5)
// ---------------------------------------------------------------------------

/**
 * Options for the content-negotiation predicates and middleware.
 *
 * @since 0.1.0
 * @category models
 */
export interface NegotiationOptions {
  /**
   * The JSON:API extension URIs this api supports (e.g.
   * `Atomic.EXTENSION_URI`). Media types carrying `ext` parameters whose URIs
   * are not all supported are rejected (415 / 406), per the spec.
   *
   * Defaults to none.
   */
  readonly extensions?: ReadonlyArray<string>
}

/**
 * Splits one media type entry into its (lowercased) base type and its
 * parameters.
 */
const parseMediaType = (
  entry: string
): { readonly base: string; readonly parameters: ReadonlyArray<readonly [name: string, value: string]> } => {
  const [first, ...rest] = entry.split(";")
  return {
    base: (first ?? "").trim().toLowerCase(),
    parameters: rest.map((part) => {
      const eq = part.indexOf("=")
      if (eq === -1) return [part.trim().toLowerCase(), ""] as const
      const name = part.slice(0, eq).trim().toLowerCase()
      const value = part.slice(eq + 1).trim()
      // Parameter values may be quoted (ext / profile URI lists always are).
      const unquoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value
      return [name, unquoted] as const
    })
  }
}

/**
 * JSON:API §5: a JSON:API media type instance is acceptable when its only
 * parameters are `ext` and `profile`, and every `ext` URI is supported.
 * Unsupported profiles are ignored (never rejected), per the spec.
 */
const parametersAreAcceptable = (
  parameters: ReadonlyArray<readonly [name: string, value: string]>,
  extensions: ReadonlyArray<string>
): boolean => {
  for (const [name, value] of parameters) {
    if (name === "profile") continue
    if (name === "ext") {
      const uris = value.split(" ").filter((uri) => uri !== "")
      if (!uris.every((uri) => extensions.includes(uri))) return false
      continue
    }
    // Any parameter other than ext / profile is unacceptable.
    return false
  }
  return true
}

/**
 * JSON:API §5: the server MUST respond with 415 if the request `Content-Type`
 * is the JSON:API media type with any media type parameters other than `ext`
 * or `profile`, or with an `ext` parameter carrying unsupported extension
 * URIs.
 *
 * Other content types are left to the downstream payload decoder.
 *
 * @since 0.1.0
 * @category utils
 */
export const contentTypeIsAcceptable = (header: string | undefined, options?: NegotiationOptions): boolean => {
  if (header === undefined) return true
  const { base, parameters } = parseMediaType(header.trim())
  if (base !== MEDIA_TYPE) return true
  return parametersAreAcceptable(parameters, options?.extensions ?? [])
}

/**
 * JSON:API §5: the server MUST respond with 406 if every instance of the
 * JSON:API media type in `Accept` carries media type parameters other than
 * `ext` / `profile` (or unsupported `ext` URIs). An `Accept` containing
 * `*​/*` or `application/*` always satisfies the rule.
 *
 * @since 0.1.0
 * @category utils
 */
export const acceptIsAcceptable = (header: string | undefined, options?: NegotiationOptions): boolean => {
  if (header === undefined) return true
  const entries = header.split(",").map((entry) => entry.trim())
  for (const entry of entries) {
    if (entry === "") continue
    const { base, parameters } = parseMediaType(entry)
    if (base === "*/*" || base === "application/*") return true
    if (base !== MEDIA_TYPE) continue
    if (parametersAreAcceptable(parameters, options?.extensions ?? [])) return true
  }
  return false
}

/**
 * Runs JSON:API §5 content negotiation over request headers, independent of
 * Effect's HttpApi — for use in a plain framework hook that owns the URL
 * (e.g. a SvelteKit hook) rather than an `HttpApi`.
 *
 * Returns the {@link ApiError} the spec requires when negotiation fails — a 415
 * {@link UnsupportedMediaType} for an unacceptable `Content-Type`, or a 406
 * {@link NotAcceptable} for an unacceptable `Accept` — or `undefined` when the
 * request is acceptable. Render the returned error to a JSON:API error document
 * with `ApiError.toDocument(error)`.
 *
 * @example
 * ```ts
 * import { ApiError, Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * // inside a framework hook, from the request headers:
 * const error = Middleware.negotiate({
 *   contentType: "application/vnd.api+json",
 *   accept: "application/vnd.api+json"
 * })
 * if (error !== undefined) {
 *   // render the spec error body for the hook's response
 *   const body = ApiError.toDocument(error)
 *   console.log(body.errors[0]?.status)
 * }
 * ```
 *
 * @since 0.3.0
 * @category utils
 */
export const negotiate = (
  headers: {
    readonly contentType?: string | undefined
    readonly accept?: string | undefined
  },
  options?: NegotiationOptions
): UnsupportedMediaType | NotAcceptable | undefined => {
  if (!contentTypeIsAcceptable(headers.contentType, options)) return new UnsupportedMediaType()
  if (!acceptIsAcceptable(headers.accept, options)) return new NotAcceptable()
  return undefined
}

/**
 * The part of a request whose decoding failed — the vocabulary
 * `HttpApiSchemaError` uses, and the input to {@link schemaError}.
 *
 * @since 0.7.0
 * @category models
 */
export type RequestPart = "Params" | "Headers" | "Query" | "Body" | "Payload"

/**
 * The JSON:API 400 a request-validation failure produces — the standalone form
 * of what {@link SchemaErrorsLive} applies inside `HttpApi`.
 *
 * Pair it with {@link negotiate} to run the package's §5 negotiation and its
 * request-validation error shape from a plain framework hook that owns the URL,
 * without adopting the `Endpoint` constructors: decode with your own schemas,
 * and render this error with `ApiError.toDocument` when decoding fails. The
 * resulting document is byte-identical to the one an `Endpoint`-built api
 * returns, so both halves of a shared URL space answer alike.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * const Query = Schema.Struct({ limit: Schema.FiniteFromString })
 *
 * // inside a framework hook, decoding the request yourself:
 * const decode = (params: Record<string, string>) => {
 *   const result = Schema.decodeUnknownExit(Query)(params)
 *   if (result._tag === "Failure") {
 *     const body = ApiError.toDocument(Middleware.schemaError("Query"))
 *     return { status: 400, body }
 *   }
 *   return { status: 200, body: result.value }
 * }
 *
 * console.log(decode({ limit: "nope" }).status) // 400
 * ```
 *
 * @since 0.7.0
 * @category utils
 */
export const schemaError = (part: RequestPart): BadRequest =>
  new BadRequest({ detail: `Request ${part.toLowerCase()} failed validation` })

// A JSON Pointer (RFC 6901) from an issue path.
const jsonPointer = (path: ReadonlyArray<string | number>): string =>
  "/" + path.map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")

// The `source` of one error object, from the part that failed and the issue's
// path: query keys are re-bracketed (`["page", "limit"]` → `page[limit]`; a
// grammar key like `filter[age][gt]` is already one segment) up to the first
// list index — everything after an index is inside a decoded value (the sort
// codec's `["sort", 0, "field"]`), not part of the wire key; path params and
// headers take the first segment; bodies take the JSON Pointer.
const sourceOf = (part: RequestPart, path: ReadonlyArray<string | number>): typeof ErrorSource.Type | undefined => {
  switch (part) {
    case "Query": {
      const keys: Array<string> = []
      for (const segment of path) {
        if (typeof segment !== "string") break
        keys.push(segment)
      }
      if (keys.length === 0) return undefined
      return {
        parameter:
          keys[0]! +
          keys
            .slice(1)
            .map((key) => `[${key}]`)
            .join("")
      }
    }
    case "Params": {
      const key = path.find((segment): segment is string => typeof segment === "string")
      return key === undefined ? undefined : { parameter: key }
    }
    case "Headers": {
      const key = path.find((segment): segment is string => typeof segment === "string")
      return key === undefined ? undefined : { header: key }
    }
    case "Body":
    case "Payload":
      return path.length === 0 ? undefined : { pointer: jsonPointer(path) }
  }
}

/**
 * The JSON:API 400 document for a request-validation failure, from the
 * failure itself: one error object per issue the failure reports, each with
 * `status` `"400"`, `code` `"bad_request"`, `title` `"Bad Request"`, the
 * issue's message as `detail`, and a `source` naming what failed —
 * `source.parameter` for a query (`page[limit]`, `filter[age][gt]`) or path
 * parameter, `source.header` for a header, `source.pointer` (a JSON Pointer,
 * `/data/attributes/title`) for a body. When no source can be derived (the
 * whole part is malformed) it is the single-error document of
 * {@link schemaError}.
 *
 * How many issues a failure reports is the decoder's choice: HttpApi decodes
 * with the default parse options (`errors: "first"`), so inside
 * {@link SchemaErrorsLive} a part yields one error object, except the `filter`
 * family, whose codec reports every offending key together. Decode with
 * `errors: "all"` yourself to get every failing value.
 *
 * This is what {@link SchemaErrorsLive} answers with; reach for it directly
 * from a plain framework hook that decodes requests itself.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * const Query = Schema.Struct({ limit: Schema.FiniteFromString })
 *
 * const result = Schema.decodeUnknownResult(Query)({ limit: "nope" })
 * if (result._tag === "Failure") {
 *   Middleware.schemaErrorDocument("Query", result.failure)
 *   // → { errors: [{ status: "400", code: "bad_request", title: "Bad Request",
 *   //                detail: "Expected a finite number", source: { parameter: "limit" } }] }
 * }
 * ```
 *
 * @since 0.13.0
 * @category utils
 */
export const schemaErrorDocument = (
  part: RequestPart,
  error: Schema.SchemaError | SchemaIssue.Issue
): typeof WireDocument.Type => {
  const issue = SchemaIssue.isIssue(error) ? error : error.issue
  const leaves = SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues
  const errors = leaves.map((leaf) => {
    const path = (leaf.path ?? []).flatMap((segment) => {
      const key = typeof segment === "object" ? segment.key : segment
      return typeof key === "string" || typeof key === "number" ? [key] : []
    })
    return { detail: leaf.message, source: sourceOf(part, path) }
  })
  if (!errors.some((error) => error.source !== undefined)) return toDocument(schemaError(part))
  return {
    errors: errors.map(({ detail, source }) => ({
      status: String(BadRequest.status),
      code: BadRequest.code,
      ...(BadRequest.title !== undefined ? { title: BadRequest.title } : {}),
      detail,
      ...(source !== undefined ? { source } : {})
    }))
  }
}

// ---------------------------------------------------------------------------
// Middleware services
// ---------------------------------------------------------------------------

/**
 * Enforces JSON:API §5 content negotiation. Fails with
 * {@link UnsupportedMediaType} (415) or {@link NotAcceptable} (406), both of
 * which encode to JSON:API error documents.
 *
 * @since 0.1.0
 * @category services
 */
export class ContentNegotiation extends HttpApiMiddleware.Service<ContentNegotiation>()(
  "effect-jsonapi/ContentNegotiation",
  { error: [NotAcceptable.wire, UnsupportedMediaType.wire] as const }
) {}

/**
 * Converts request validation failures (`HttpApiSchemaError`: malformed
 * params, query, payload or headers) into JSON:API 400 error documents.
 *
 * @since 0.1.0
 * @category services
 */
export class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()("effect-jsonapi/SchemaErrors", {
  error: BadRequest.wire
}) {}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * Creates the live {@link ContentNegotiation} implementation, optionally
 * supporting JSON:API extensions (e.g. atomic operations).
 *
 * @since 0.1.0
 * @category constructors
 */
export const contentNegotiationLayer = (options?: NegotiationOptions): Layer.Layer<ContentNegotiation> =>
  Layer.effect(
    ContentNegotiation,
    Effect.succeed<typeof ContentNegotiation.Service>((httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest
        if (!contentTypeIsAcceptable(request.headers["content-type"], options)) {
          return yield* Effect.fail(new UnsupportedMediaType())
        }
        if (!acceptIsAcceptable(request.headers["accept"], options)) {
          return yield* Effect.fail(new NotAcceptable())
        }
        return yield* httpEffect
      })
    )
  )

/**
 * The live {@link ContentNegotiation} implementation (no extensions).
 *
 * @since 0.1.0
 * @category layers
 */
export const ContentNegotiationLive: Layer.Layer<ContentNegotiation> = contentNegotiationLayer()

/**
 * The live {@link SchemaErrors} implementation: answers every request
 * validation failure with the JSON:API 400 error document of
 * {@link schemaErrorDocument} — an error object per reported issue (one per
 * request part under HttpApi's `errors: "first"`, every offending key for the
 * `filter` family), each with a `detail` and a `source` naming the offending
 * parameter, header or body member.
 *
 * @since 0.1.0
 * @category layers
 */
export const SchemaErrorsLive: Layer.Layer<SchemaErrors> = HttpApiMiddleware.layerSchemaErrorTransform(
  SchemaErrors,
  // `ResponseHeaders` failures are a server-side bug (the handler's own response
  // doesn't satisfy its declared schema), not a client request-validation error —
  // re-fail with the original error instead of mislabeling it a 400.
  (error) =>
    error.kind === "ResponseHeaders"
      ? Effect.fail(error)
      : Effect.succeed(
          HttpServerResponse.jsonUnsafe(schemaErrorDocument(error.kind, error.cause), {
            status: BadRequest.status,
            contentType: MEDIA_TYPE
          })
        )
)

/**
 * A {@link ContentNegotiation} implementation that performs **no** §5 checks —
 * for apis whose host already negotiated content upstream.
 *
 * The `Endpoint` constructors attach {@link ContentNegotiation} to every
 * endpoint, so an `HttpApi` built from them cannot be provided without it.
 * That is the right default — compliance can't be forgotten — but it assumes
 * the api owns negotiation. A host that serves JSON:API alongside HTML on one
 * URL space negotiates in its own hook instead (see {@link negotiate}), and
 * running §5 twice is at best redundant and at worst contradictory: a host that
 * deliberately accepts `Accept: application/json` for its api would have those
 * requests rejected with a 406 by the middleware after the hook admitted them.
 *
 * Providing this layer in place of {@link ContentNegotiationLive} satisfies the
 * endpoints' requirement while leaving the host the single negotiating
 * authority. Nothing else changes — {@link SchemaErrors} and every endpoint's
 * schemas, errors and documents are untouched. Use
 * {@link layerHostNegotiated} for the whole set.
 *
 * Reach for this only when something upstream genuinely enforces §5; on an api
 * that owns its own URLs, {@link layer} remains the correct choice.
 *
 * @since 0.7.0
 * @category layers
 */
export const ContentNegotiationPassthrough: Layer.Layer<ContentNegotiation> = Layer.effect(
  ContentNegotiation,
  Effect.succeed<typeof ContentNegotiation.Service>((httpEffect) => httpEffect)
)

/**
 * Everything a JSON:API api needs to run **when its host negotiates content**:
 * {@link ContentNegotiationPassthrough} plus the live {@link SchemaErrors}.
 *
 * The drop-in replacement for {@link layer} in an application whose framework
 * hook has already applied §5 — typically with {@link negotiate}, so the rules
 * are the package's either way.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * // `ArticlesLive` etc. are your `HttpApiBuilder.group(...)` implementations.
 * const ArticlesLive: Layer.Layer<never> = Layer.empty
 *
 * // The surrounding framework hook ran `Middleware.negotiate` already, so the
 * // api itself does not re-negotiate — it still emits JSON:API 400s.
 * const ApiLive = Layer.mergeAll(ArticlesLive).pipe(
 *   Layer.provideMerge(Middleware.layerHostNegotiated)
 * )
 * ```
 *
 * @since 0.7.0
 * @category layers
 */
export const layerHostNegotiated: Layer.Layer<ContentNegotiation | SchemaErrors> = Layer.mergeAll(
  ContentNegotiationPassthrough,
  SchemaErrorsLive
)

/**
 * Everything a JSON:API api needs to run: provide this layer alongside your
 * `HttpApiBuilder` group implementations.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * // `UsersLive` etc. are your `HttpApiBuilder.group(...)` implementations.
 * const UsersLive: Layer.Layer<never> = Layer.empty
 *
 * // Provide the JSON:API middleware *into* the handler groups so every
 * // endpoint's middleware requirement is satisfied.
 * const ApiLive = Layer.mergeAll(UsersLive).pipe(
 *   Layer.provideMerge(Middleware.layer)
 * )
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<ContentNegotiation | SchemaErrors> = Layer.mergeAll(
  ContentNegotiationLive,
  SchemaErrorsLive
)

/**
 * Like {@link layer}, with content-negotiation options — required when the api
 * uses JSON:API extensions.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { Atomic, Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * const HandlersLive: Layer.Layer<never> = Layer.empty
 *
 * // Accept the atomic operations extension's media type.
 * const ApiLive = Layer.mergeAll(HandlersLive).pipe(
 *   Layer.provideMerge(
 *     Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })
 *   )
 * )
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layerWith = (options: NegotiationOptions): Layer.Layer<ContentNegotiation | SchemaErrors> =>
  Layer.mergeAll(contentNegotiationLayer(options), SchemaErrorsLive)
