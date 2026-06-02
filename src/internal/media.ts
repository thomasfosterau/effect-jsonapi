/**
 * JSON:API media type constants and schema annotation helpers.
 *
 * @internal
 */
import type { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"

/**
 * The JSON:API media type, per https://jsonapi.org/format/1.1/#content-negotiation-all
 */
export const MEDIA_TYPE = "application/vnd.api+json"

const JSONAPI = { contentType: MEDIA_TYPE } as const

/**
 * Marks a schema as a JSON:API body (`application/vnd.api+json`) and
 * optionally sets its HTTP status.
 *
 * No return annotation: the inferred type carries the exact schema through so
 * Success/Error/Payload inference is preserved at endpoint declaration sites.
 */
export const asJsonApi = <S extends Schema.Top>(schema: S, status?: number) => {
  const body = schema.pipe(HttpApiSchema.asJson(JSONAPI))
  return status === undefined ? body : body.pipe(HttpApiSchema.status(status))
}
