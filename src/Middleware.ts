/**
 * JSON:API protocol middleware.
 *
 * Two `HttpApiMiddleware` services enforce the parts of the spec that live
 * outside schemas:
 *
 *   - {@link ContentNegotiation} — JSON:API §5 content negotiation:
 *       - a request `Content-Type: application/vnd.api+json` carrying media
 *         type parameters → 415 Unsupported Media Type
 *       - an `Accept` header in which every instance of the JSON:API media
 *         type carries parameters → 406 Not Acceptable
 *   - {@link SchemaErrors} — converts request validation failures (malformed
 *     query parameters, payloads, path parameters) into spec-compliant
 *     JSON:API 400 error documents instead of the default HttpApi error shape.
 *
 * Both middlewares are attached automatically by the `Endpoint` constructors,
 * so any `HttpApi` containing JSON:API endpoints will fail to build (at the
 * type level) until {@link layer} is provided — compliance cannot be
 * forgotten.
 */
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { BadRequest, NotAcceptable, UnsupportedMediaType } from "./ApiError.js"
import { MEDIA_TYPE } from "./internal/media.js"

// ---------------------------------------------------------------------------
// Content negotiation predicates (JSON:API §5)
// ---------------------------------------------------------------------------

const stripWeight = (value: string): string => {
  const semi = value.indexOf(";")
  return (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase()
}

/**
 * JSON:API §5: the server MUST respond with 415 if the request `Content-Type`
 * is the JSON:API media type *and* carries any media type parameters.
 *
 * Other content types are left to the downstream payload decoder.
 */
export const contentTypeIsAcceptable = (header: string | undefined): boolean => {
  if (header === undefined) return true
  const trimmed = header.trim().toLowerCase()
  const semi = trimmed.indexOf(";")
  if (semi === -1) return true
  const base = trimmed.slice(0, semi).trim()
  return base !== MEDIA_TYPE
}

/**
 * JSON:API §5: the server MUST respond with 406 if every instance of the
 * JSON:API media type in `Accept` carries media type parameters. An `Accept`
 * containing `*​/*` or `application/*` always satisfies the rule.
 */
export const acceptIsAcceptable = (header: string | undefined): boolean => {
  if (header === undefined) return true
  const entries = header.split(",").map((entry) => entry.trim().toLowerCase())
  for (const entry of entries) {
    if (entry === "") continue
    if (entry === "*/*" || entry.startsWith("*/*;")) return true
    if (entry === "application/*" || entry.startsWith("application/*;")) return true
    const base = stripWeight(entry)
    if (base === MEDIA_TYPE && entry === base) {
      // Unparameterised match: accepted.
      return true
    }
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
 */
export class ContentNegotiation extends HttpApiMiddleware.Service<ContentNegotiation>()(
  "effect-jsonapi/ContentNegotiation",
  { error: [NotAcceptable.wire, UnsupportedMediaType.wire] as const }
) {}

/**
 * Converts request validation failures (`HttpApiSchemaError`: malformed
 * params, query, payload or headers) into JSON:API 400 error documents.
 */
export class SchemaErrors extends HttpApiMiddleware.Service<SchemaErrors>()(
  "effect-jsonapi/SchemaErrors",
  { error: BadRequest.wire }
) {}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * The live {@link ContentNegotiation} implementation.
 */
export const ContentNegotiationLive: Layer.Layer<ContentNegotiation> = Layer.effect(
  ContentNegotiation,
  Effect.succeed<typeof ContentNegotiation.Service>((httpEffect) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest
      if (!contentTypeIsAcceptable(request.headers["content-type"])) {
        return yield* Effect.fail(new UnsupportedMediaType())
      }
      if (!acceptIsAcceptable(request.headers["accept"])) {
        return yield* Effect.fail(new NotAcceptable())
      }
      return yield* httpEffect
    })
  )
)

/**
 * The live {@link SchemaErrors} implementation: rewraps every request
 * validation failure as a JSON:API 400 error document.
 */
export const SchemaErrorsLive: Layer.Layer<SchemaErrors> = HttpApiMiddleware.layerSchemaErrorTransform(
  SchemaErrors,
  (error) => Effect.fail(new BadRequest({ detail: `Request ${error.kind.toLowerCase()} failed validation` }))
)

/**
 * Everything a JSON:API api needs to run: provide this layer alongside your
 * `HttpApiBuilder` group implementations.
 */
export const layer: Layer.Layer<ContentNegotiation | SchemaErrors> = Layer.mergeAll(
  ContentNegotiationLive,
  SchemaErrorsLive
)
