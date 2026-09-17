/**
 * Media type annotation combinators for hand-rolled JSON:API endpoints.
 *
 * When building custom endpoints with `HttpApiEndpoint`, use these
 * combinators to mark your success or payload schemas with their media type
 * — the same annotations the package's own {@link Endpoint} constructors use
 * internally. This is especially useful for hosts that handle content
 * negotiation (RFC 7231 §6) themselves and dispatch writes under a media type
 * different from what the endpoint advertises.
 *
 * @since 0.15.0
 */
import type { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"

/**
 * The JSON:API media type, per
 * {@link https://jsonapi.org/format/1.1/#content-negotiation-all the spec}.
 *
 * Re-exported from the package root as `MEDIA_TYPE`.
 *
 * @since 0.1.0
 * @category constants
 */
const MEDIA_TYPE = "application/vnd.api+json"

/**
 * Marks a schema as a JSON:API body and optionally sets its HTTP status.
 *
 * Use this to annotate the success or payload schema of a hand-rolled
 * `HttpApiEndpoint` with the JSON:API media type. The inferred type carries
 * the exact schema through, so Success and Payload type inference is preserved
 * — the combinator is transparent to the endpoint's type signature.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApiEndpoint } from "effect/unstable/httpapi"
 * import { Document, MediaType, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person)
 *   }
 * })
 *
 * // A custom endpoint that might not fit the high-level Endpoint constructors,
 * // but still needs to serve JSON:API documents with the right media type
 * const customArticleEndpoint = HttpApiEndpoint.get(
 *   "custom-article",
 *   "/articles/special/:id",
 *   {
 *     params: { id: Schema.String },
 *     success: MediaType.asJsonApi(
 *       Document.DataDocument(Article),
 *       200
 *     )
 *   }
 * )
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const asJsonApi = <S extends Schema.Top>(schema: S, status?: number) => {
  const body = schema.pipe(HttpApiSchema.asJson({ contentType: MEDIA_TYPE }))
  return status === undefined ? body : body.pipe(HttpApiSchema.status(status))
}

/**
 * Marks a schema as a body at an arbitrary media type.
 *
 * Use this for endpoints that need to serve or accept a specific media type
 * that isn't the JSON:API default. This is the seam behind write endpoints'
 * `payloadMediaType` option, where a host that negotiates content types (RFC
 * 7231 §6) itself and dispatches writes to the router under a different media
 * type needs the router's request registration left at that dispatched type.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApiEndpoint } from "effect/unstable/httpapi"
 * import { MediaType, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * // A custom endpoint that accepts plain JSON (not JSON:API)
 * // because the host's content-negotiation layer relabels the request
 * const customCreateEndpoint = HttpApiEndpoint.post(
 *   "custom-create",
 *   "/articles",
 *   {
 *     payload: MediaType.asMediaType(
 *       Article.createInput,
 *       "application/json"
 *     ),
 *     success: MediaType.asJsonApi(Article.document(), 201)
 *   }
 * )
 * ```
 *
 * @since 0.15.0
 * @category combinators
 */
export const asMediaType = <S extends Schema.Top>(schema: S, contentType: string) =>
  schema.pipe(HttpApiSchema.asJson({ contentType }))
