/**
 * The media type annotation helpers, as the package's own modules consume
 * them.
 *
 * These bind a schema to `effect/unstable/httpapi`, so they are kept out of
 * `./media.js` — that module holds the media type *constants*, which the
 * schema-only entry point reaches and which must stay free of the HTTP
 * surface.
 *
 * {@link asJsonApi} and {@link asMediaType} are the public {@link MediaType}
 * combinators; they are re-exported here so internal callers have one import
 * site for the HTTP-tier annotations.
 *
 * @since 0.15.0
 * @internal
 */
import type { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"
import { ATOMIC_MEDIA_TYPE } from "./media.js"

export { asJsonApi, asMediaType } from "../MediaType.js"

const JSONAPI_ATOMIC = { contentType: ATOMIC_MEDIA_TYPE } as const

/**
 * Marks a schema as an atomic operations *response* body: the JSON:API media
 * type with the atomic `ext` parameter, per the extension's requirement that
 * responses carry it.
 *
 * Request payloads keep the bare media type annotation (`asJsonApi`) because
 * routing matches request content types with their parameters stripped; the
 * extension parameter on requests is validated by the content-negotiation
 * middleware instead.
 *
 * @since 0.1.0
 * @category utils
 * @internal
 */
export const asJsonApiAtomic = <S extends Schema.Top>(schema: S, status?: number) => {
  const body = schema.pipe(HttpApiSchema.asJson(JSONAPI_ATOMIC))
  return status === undefined ? body : body.pipe(HttpApiSchema.status(status))
}
