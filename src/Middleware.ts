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
 *     JSON:API 400 error documents instead of the default HttpApi error shape.
 *
 * Both middlewares are attached automatically by the `Endpoint` constructors,
 * so any `HttpApi` containing JSON:API endpoints will fail to build (at the
 * type level) until {@link layer} is provided — compliance cannot be
 * forgotten.
 *
 * @since 0.1.0
 */
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { BadRequest, NotAcceptable, UnsupportedMediaType } from "./ApiError.js"
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
 * The live {@link SchemaErrors} implementation: rewraps every request
 * validation failure as a JSON:API 400 error document.
 *
 * @since 0.1.0
 * @category layers
 */
export const SchemaErrorsLive: Layer.Layer<SchemaErrors> = HttpApiMiddleware.layerSchemaErrorTransform(
  SchemaErrors,
  (error) => Effect.fail(new BadRequest({ detail: `Request ${error.kind.toLowerCase()} failed validation` }))
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
