/**
 * HTTP integration utilities for JSON:API with @effect/platform
 */

import * as Effect from "effect/Effect"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import type * as Schema from "./Schema"
import * as S from "effect/Schema"
import * as DocumentSchema from "./Schema"

/**
 * JSON:API media type constant
 */
export const JSONAPI_MEDIA_TYPE = "application/vnd.api+json" as const

/**
 * Create HTTP headers for JSON:API response
 */
export const jsonApiHeaders = (): Record<string, string> => ({
  "Content-Type": JSONAPI_MEDIA_TYPE
})

/**
 * Create a JSON:API response with proper headers
 */
export const jsonApiResponse = (
  document: Schema.Document,
  status = 200
) =>
  HttpServerResponse.json(document, { status }).pipe(
    Effect.map(response =>
      response.pipe(
        HttpServerResponse.setHeader("Content-Type", JSONAPI_MEDIA_TYPE)
      )
    )
  )

/**
 * Create a successful JSON:API response with a single resource
 */
export const successOneResponse = (
  resource: Schema.ResourceObject,
  options?: {
    included?: Schema.ResourceObject[]
    links?: Schema.Links
    meta?: Record<string, unknown>
    status?: number
  }
) => {
  const document: Schema.Document = {
    data: resource,
    included: options?.included,
    links: options?.links,
    meta: options?.meta
  }
  return jsonApiResponse(document, options?.status ?? 200)
}

/**
 * Create a successful JSON:API response with multiple resources
 */
export const successManyResponse = (
  resources: Schema.ResourceObject[],
  options?: {
    included?: Schema.ResourceObject[]
    links?: Schema.Links
    meta?: Record<string, unknown>
    status?: number
  }
) => {
  const document: Schema.Document = {
    data: resources,
    included: options?.included,
    links: options?.links,
    meta: options?.meta
  }
  return jsonApiResponse(document, options?.status ?? 200)
}

/**
 * Create a JSON:API error response
 */
export const errorResponse = (
  errors: Schema.ErrorObject[],
  options?: {
    meta?: Record<string, unknown>
    status?: number
  }
) => {
  const document: Schema.Document = {
    errors,
    meta: options?.meta
  }
  const status = options?.status ?? (errors[0]?.status ? parseInt(errors[0].status) : 500)
  return jsonApiResponse(document, status)
}

/**
 * Create a 404 Not Found error response
 */
export const notFoundResponse = (
  detail = "The requested resource does not exist"
) =>
  errorResponse([
    {
      status: "404",
      title: "Not Found",
      detail
    }
  ], { status: 404 })

/**
 * Create a 400 Bad Request error response
 */
export const badRequestResponse = (
  detail: string,
  source?: Schema.ErrorSource
) =>
  errorResponse([
    {
      status: "400",
      title: "Bad Request",
      detail,
      source
    }
  ], { status: 400 })

/**
 * Create a 422 Unprocessable Entity error response
 */
export const unprocessableEntityResponse = (
  errors: Schema.ErrorObject[]
) =>
  errorResponse(errors, { status: 422 })

/**
 * Validate that the request has the correct Content-Type header
 */
export const validateContentType = (
  request: HttpServerRequest.HttpServerRequest
) =>
  Effect.gen(function* () {
    const contentType = request.headers["content-type"]
    if (contentType && !contentType.includes(JSONAPI_MEDIA_TYPE)) {
      return yield* Effect.fail(
        badRequestResponse(
          `Content-Type must be ${JSONAPI_MEDIA_TYPE}`
        )
      )
    }
  })

/**
 * Validate that the request has the correct Accept header
 */
export const validateAccept = (
  request: HttpServerRequest.HttpServerRequest
) =>
  Effect.gen(function* () {
    const accept = request.headers["accept"]
    if (accept && accept !== "*/*" && !accept.includes(JSONAPI_MEDIA_TYPE)) {
      return yield* Effect.fail(
        badRequestResponse(
          `Accept header must include ${JSONAPI_MEDIA_TYPE}`
        )
      )
    }
  })

/**
 * Parse and validate a JSON:API document from request body
 */
export const parseDocument = (
  request: HttpServerRequest.HttpServerRequest
) =>
  Effect.gen(function* () {
    const body = yield* request.json.pipe(
      Effect.catchAll(() =>
        Effect.fail(
          badRequestResponse("Invalid JSON in request body")
        )
      )
    )

    const parseResult = S.decodeUnknownEither(DocumentSchema.Document)(body)
    
    if (parseResult._tag === "Left") {
      return yield* Effect.fail(
        badRequestResponse(
          "Invalid JSON:API document structure"
        )
      )
    }
    
    return parseResult.right
  })
