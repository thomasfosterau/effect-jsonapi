/**
 * One-shot JSON:API error declarations.
 *
 * {@link make} produces a tagged error class — usable with `Effect.fail`,
 * `Effect.catchTag`, `yield*` — whose wire encoding is a spec-compliant
 * JSON:API error document carrying the declared HTTP status:
 *
 * ```ts
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   code: "not_found",
 *   title: "Resource not found",
 *   fields: { id: Schema.String },
 *   detail: (e) => `Article ${e.id} not found`
 * }) {}
 *
 * // in a handler:           Effect.fail(new ArticleNotFound({ id }))
 * // on the wire:            { "errors": [{ "status": "404", "code": "not_found", ... }] }
 * // in a client:            Effect.catchTag("ArticleNotFound", ...)
 * ```
 *
 * The declared `fields` are round-tripped through the error object's `meta`
 * member, so clients can reconstruct the typed error from the wire document.
 *
 * @since 0.1.0
 */
import type { Cause } from "effect"
import { Schema, SchemaTransformation } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"
import { ErrorDocument, ErrorObject } from "./Document.js"
import { asJsonApi } from "./internal/media.js"

/**
 * The wire document schema every {@link make} error encodes to.
 *
 * @since 0.1.0
 * @category schemas
 */
export const WireDocument = ErrorDocument(ErrorObject)

type WireDocumentType = typeof WireDocument.Type

/**
 * The endpoint error schema derived from an error class: decodes a JSON:API
 * error document into an instance of the class (and back).
 *
 * @since 0.1.0
 * @category models
 */
export interface Wire<Self, Tag extends string, Fields extends Schema.Struct.Fields> extends Schema.decodeTo<
  Schema.Class<Self, Schema.TaggedStruct<Tag, Fields>, Cause.YieldableError>,
  typeof WireDocument,
  never,
  never
> {}

/**
 * The class returned by {@link make}: a `Schema.TaggedErrorClass` augmented
 * with the JSON:API error metadata and the derived wire schema.
 *
 * @since 0.1.0
 * @category models
 */
export interface ApiErrorClass<Self, Tag extends string, Fields extends Schema.Struct.Fields> extends Schema.Class<
  Self,
  Schema.TaggedStruct<Tag, Fields>,
  Cause.YieldableError
> {
  /** The HTTP status this error responds with. */
  readonly status: number
  /** The JSON:API error `code` (application-specific identifier). */
  readonly code: string
  /** The JSON:API error `title`, if declared. */
  readonly title: string | undefined
  /**
   * The endpoint error schema: an instance of this class on the Effect side,
   * a JSON:API error document on the wire, annotated with the HTTP status and
   * the JSON:API media type.
   */
  readonly wire: Wire<Self, Tag, Fields>
}

/**
 * Configuration for a JSON:API error declaration.
 *
 * @since 0.1.0
 * @category models
 */
export interface Config<Fields extends Schema.Struct.Fields> {
  /** HTTP status code for this error response (e.g. 404, 409, 422). */
  readonly status: number
  /**
   * JSON:API error `code`: an application-specific identifier, stable across
   * occurrences. Defaults to the snake_cased tag.
   */
  readonly code?: string
  /** JSON:API error `title`: a human-readable summary, constant across occurrences. */
  readonly title?: string
  /**
   * Typed fields carried by the error. Round-tripped through the error
   * object's `meta` member so clients can reconstruct the error.
   */
  readonly fields?: Fields
  /**
   * JSON:API error `detail`: a human-readable explanation specific to this
   * occurrence. Either a constant string or a function of the (encoded) fields.
   */
  readonly detail?: string | ((fields: Schema.Struct.Encoded<NoInfer<Fields>>) => string | undefined)
}

const snakeCase = (tag: string): string =>
  tag
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase()

// Wire schemas are derived lazily (so they bind to the user's final subclass,
// preserving `instanceof`) and cached per class.
const wireCache = new WeakMap<object, unknown>()

const makeWire = (
  klass: { new (...args: Array<any>): any },
  options: {
    readonly tag: string
    readonly status: number
    readonly code: string
    readonly title: string | undefined
    readonly fieldKeys: ReadonlyArray<string>
    readonly detail: ((fields: any) => string | undefined) | undefined
  }
) => {
  const cached = wireCache.get(klass)
  if (cached !== undefined) return cached

  // The wire document only decodes error documents carrying *this* error's
  // status and code, so unions of error schemas stay discriminated — e.g. an
  // endpoint declaring both `IssueNotFound` and `UserNotFound` (two 404s with
  // distinct codes) decodes each document into the right class.
  const strictDocument = ErrorDocument(
    Schema.Struct({
      ...ErrorObject.fields,
      status: Schema.Literals([String(options.status)]),
      code: Schema.Literals([options.code])
    })
  ) as unknown as typeof WireDocument

  const wire = strictDocument
    .pipe(
      Schema.decodeTo(
        klass as unknown as Schema.Top,
        SchemaTransformation.transform<unknown, WireDocumentType>({
          // document -> class encoded form ({ _tag, ...fields })
          decode: (doc) => {
            const meta = doc.errors[0]?.meta ?? {}
            return {
              _tag: options.tag,
              ...Object.fromEntries(options.fieldKeys.map((key) => [key, meta[key]]))
            }
          },
          // class encoded form -> document
          encode: (encoded) => {
            const fields = encoded as Record<string, unknown>
            const detail = options.detail?.(fields)
            return {
              errors: [
                {
                  status: String(options.status),
                  code: options.code,
                  ...(options.title !== undefined ? { title: options.title } : {}),
                  ...(detail !== undefined ? { detail } : {}),
                  ...(options.fieldKeys.length > 0
                    ? { meta: Object.fromEntries(options.fieldKeys.map((key) => [key, fields[key]])) }
                    : {})
                }
              ]
            }
          }
        })
      ),
      HttpApiSchema.status(options.status)
    )
    .pipe((schema) => asJsonApi(schema))

  wireCache.set(klass, wire)
  return wire
}

/**
 * Declares a JSON:API error in one shot: a tagged error class whose wire
 * encoding is a spec-compliant JSON:API error document.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError } from "@thomasfosterau/effect-jsonapi"
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   code: "not_found",
 *   title: "Resource not found",
 *   fields: { id: Schema.String },
 *   detail: (e) => `Article ${e.id} not found`
 * }) {}
 *
 * // in a handler:   Effect.fail(new ArticleNotFound({ id: "42" }))
 * // in a client:    Effect.catchTag("ArticleNotFound", (e) => ...)
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const make =
  <Self = never>(identifier?: string) =>
  <const Tag extends string, const Fields extends Schema.Struct.Fields = {}>(
    tag: Tag,
    config: Config<Fields>
  ): ApiErrorClass<Self, Tag, Fields> => {
    const fields = (config.fields ?? {}) as Fields
    const fieldKeys = Object.keys(fields)
    const code = config.code ?? snakeCase(tag)
    const detail =
      typeof config.detail === "function"
        ? config.detail
        : config.detail !== undefined
          ? () => config.detail as string
          : undefined

    // The conditional `MissingSelfGeneric` branch only matters at the user's
    // `extends` clause, where `Self` is concrete — cast it away here.
    const Base = Schema.TaggedErrorClass<Self>(identifier)(tag, fields) as unknown as new (
      ...args: Array<any>
    ) => object

    class ApiErrorBase extends Base {
      static readonly status = config.status
      static readonly code = code
      static readonly title = config.title
      static get wire() {
        // `this` is the user's final class, so decoded errors are `instanceof` it.
        return makeWire(this as unknown as { new (...args: Array<any>): any }, {
          tag,
          status: config.status,
          code,
          title: config.title,
          fieldKeys,
          detail
        })
      }
    }

    return ApiErrorBase as unknown as ApiErrorClass<Self, Tag, Fields>
  }

/**
 * Encodes an {@link make} error instance to its JSON:API error-document value
 * (`{ errors: [...] }`), independent of Effect's HttpApi.
 *
 * Use this to render a JSON:API error body from a plain framework hook (e.g. a
 * SvelteKit hook) that negotiates content or validates requests outside an
 * `HttpApi` — the same encoding the endpoint middleware applies, reachable on
 * its own.
 *
 * @example
 * ```ts
 * import { ApiError } from "@thomasfosterau/effect-jsonapi"
 *
 * const body = ApiError.toDocument(new ApiError.BadRequest({ detail: "bad query" }))
 * // → { errors: [{ status: "400", code: "bad_request", title: "Bad Request", detail: "bad query" }] }
 * ```
 *
 * @since 0.3.0
 * @category encoding
 */
export const toDocument = (error: object): typeof WireDocument.Type => {
  const wire = (error as { readonly constructor?: { readonly wire?: unknown } }).constructor?.wire
  if (wire === undefined || !Schema.isSchema(wire)) {
    throw new Error(
      "ApiError.toDocument expects an instance of an ApiError.make(...) class (with a static `wire` schema)"
    )
  }
  return Schema.encodeUnknownSync(wire as Schema.Codec<unknown, typeof WireDocument.Type>)(error)
}

// ---------------------------------------------------------------------------
// Standard errors — the responses every JSON:API endpoint must support
// ---------------------------------------------------------------------------

/**
 * 400 Bad Request: malformed query parameters or document structure.
 *
 * @since 0.1.0
 * @category errors
 */
export class BadRequest extends make<BadRequest>()("BadRequest", {
  status: 400,
  code: "bad_request",
  title: "Bad Request",
  fields: { detail: Schema.optionalKey(Schema.String) },
  detail: (e) => e.detail
}) {}

/**
 * 403 Forbidden: the client is not allowed to perform this operation.
 *
 * @since 0.1.0
 * @category errors
 */
export class Forbidden extends make<Forbidden>()("Forbidden", {
  status: 403,
  code: "forbidden",
  title: "Forbidden"
}) {}

/**
 * 406 Not Acceptable: JSON:API §5 content negotiation — the `Accept` header
 * contains the JSON:API media type only with media type parameters.
 *
 * @since 0.1.0
 * @category errors
 */
export class NotAcceptable extends make<NotAcceptable>()("NotAcceptable", {
  status: 406,
  code: "not_acceptable",
  title: "Not Acceptable"
}) {}

/**
 * 409 Conflict: the request violates server constraints (e.g. duplicate id,
 * type mismatch between the URL and the document).
 *
 * @since 0.1.0
 * @category errors
 */
export class Conflict extends make<Conflict>()("Conflict", {
  status: 409,
  code: "conflict",
  title: "Conflict",
  fields: { detail: Schema.optionalKey(Schema.String) },
  detail: (e) => e.detail
}) {}

/**
 * 415 Unsupported Media Type: JSON:API §5 content negotiation — the request
 * `Content-Type` is the JSON:API media type with media type parameters.
 *
 * @since 0.1.0
 * @category errors
 */
export class UnsupportedMediaType extends make<UnsupportedMediaType>()("UnsupportedMediaType", {
  status: 415,
  code: "unsupported_media_type",
  title: "Unsupported Media Type"
}) {}

/**
 * The error responses every JSON:API endpoint declares automatically:
 * 400 (malformed request), 406 and 415 (content negotiation).
 *
 * @since 0.1.0
 * @category constants
 */
export const Standard = [BadRequest, NotAcceptable, UnsupportedMediaType] as const
