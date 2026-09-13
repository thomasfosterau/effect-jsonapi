/**
 * Schema annotation helpers that bind a JSON:API media type to Effect's
 * `HttpApi` surface.
 *
 * Split out of `./media.js` so the media *constants* stay free of
 * `effect/unstable/httpapi`: the schema-only entry point reaches the constants,
 * and only the HTTP tier reaches these annotations.
 *
 * @since 0.15.0
 * @internal
 */
import type { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"
import { ATOMIC_MEDIA_TYPE, MEDIA_TYPE } from "./media.js"

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
