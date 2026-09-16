/**
 * JSON:API media type constants and schema annotation helpers.
 *
 * @since 0.1.0
 * @internal
 */
import type { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"

/**
 * The JSON:API media type, per
 * {@link https://jsonapi.org/format/1.1/#content-negotiation-all the spec}.
 *
 * Re-exported from the package root as `MEDIA_TYPE`.
 *
 * @example
 * ```ts
 * import { MEDIA_TYPE } from "@thomasfosterau/effect-jsonapi"
 *
 * MEDIA_TYPE // "application/vnd.api+json"
 * ```
 *
 * @since 0.1.0
 * @category constants
 */
export const MEDIA_TYPE = "application/vnd.api+json"

/**
 * The atomic operations extension URI, per https://jsonapi.org/ext/atomic/
 *
 * @since 0.1.0
 * @category constants
 * @internal
 */
export const ATOMIC_EXTENSION_URI = "https://jsonapi.org/ext/atomic"

/**
 * The base media type of one `Content-Type` / `Accept` entry: everything
 * before the first `;`, trimmed and lowercased.
 *
 * The single definition of "which media type is this?", shared by the server's
 * §5 negotiation (which then inspects the parameters) and the client's
 * header stamping (which only needs the base type).
 *
 * @since 0.15.0
 * @category utils
 * @internal
 */
export const baseMediaType = (entry: string): string => (entry.split(";", 1)[0] ?? "").trim().toLowerCase()

/**
 * The JSON:API media type carrying an `ext` parameter for the given extension
 * URIs — the exact string the spec calls for, and the one the package's own
 * §5 parser accepts: a single space-separated, double-quoted URI list.
 *
 * The single definition of "the media type this api speaks", shared by the
 * server (response body annotations) and the client (`Accept` /
 * `Content-Type` stamping), so the two cannot drift.
 *
 * @since 0.15.0
 * @category constructors
 * @internal
 */
export const mediaTypeWith = (extensions?: ReadonlyArray<string> | undefined): string =>
  extensions === undefined || extensions.length === 0 ? MEDIA_TYPE : `${MEDIA_TYPE};ext="${extensions.join(" ")}"`

/**
 * The JSON:API media type carrying the atomic operations `ext` parameter.
 *
 * @since 0.1.0
 * @category constants
 * @internal
 */
export const ATOMIC_MEDIA_TYPE = mediaTypeWith([ATOMIC_EXTENSION_URI])

const JSONAPI = { contentType: MEDIA_TYPE } as const

const JSONAPI_ATOMIC = { contentType: ATOMIC_MEDIA_TYPE } as const

/**
 * Marks a schema as a body at an arbitrary media type — the seam behind the
 * write endpoints' `payloadMediaType` option, where a host that negotiates §6
 * upstream needs the router's *request* registration left at the media type it
 * actually dispatches.
 *
 * {@link asJsonApi} is this at the JSON:API media type; everything the package
 * emits itself still goes through that one.
 *
 * @since 0.11.0
 * @category utils
 * @internal
 */
export const asMediaType = <S extends Schema.Top>(schema: S, contentType: string) =>
  schema.pipe(HttpApiSchema.asJson({ contentType }))

/**
 * Marks a schema as a JSON:API body (`application/vnd.api+json`) and
 * optionally sets its HTTP status.
 *
 * No return annotation: the inferred type carries the exact schema through so
 * Success/Error/Payload inference is preserved at endpoint declaration sites.
 *
 * @since 0.1.0
 * @category utils
 * @internal
 */
export const asJsonApi = <S extends Schema.Top>(schema: S, status?: number) => {
  const body = schema.pipe(HttpApiSchema.asJson(JSONAPI))
  return status === undefined ? body : body.pipe(HttpApiSchema.status(status))
}

/**
 * Marks a schema as an atomic operations *response* body: the JSON:API media
 * type with the atomic `ext` parameter, per the extension's requirement that
 * responses carry it.
 *
 * Request payloads keep the bare media type annotation ({@link asJsonApi})
 * because routing matches request content types with their parameters
 * stripped; the extension parameter on requests is validated by the
 * content-negotiation middleware instead.
 *
 * @since 0.1.0
 * @category utils
 * @internal
 */
export const asJsonApiAtomic = <S extends Schema.Top>(schema: S, status?: number) => {
  const body = schema.pipe(HttpApiSchema.asJson(JSONAPI_ATOMIC))
  return status === undefined ? body : body.pipe(HttpApiSchema.status(status))
}
