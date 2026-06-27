import { describe, expect, expectTypeOf, it } from "vitest"
import { Effect, Schema } from "effect"
import * as ApiError from "./ApiError.js"

class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
  fields: { id: Schema.String },
  detail: (e) => `Article ${e.id} not found`
}) {}

class TitleTaken extends ApiError.make<TitleTaken>()("TitleTaken", {
  status: 409,
  fields: { title: Schema.String }
}) {}

class RateLimited extends ApiError.make<RateLimited>()("RateLimited", {
  status: 429,
  title: "Too Many Requests"
}) {}

describe("ApiError.make", () => {
  it("creates a yieldable tagged error class", async () => {
    const error = new ArticleNotFound({ id: "42" })
    expect(error._tag).toBe("ArticleNotFound")
    expect(error.id).toBe("42")
    expect(error).toBeInstanceOf(Error)

    // usable in Effect error channels with catchTag
    const recovered = await Effect.runPromise(
      Effect.fail(new ArticleNotFound({ id: "42" })).pipe(
        Effect.catchTag("ArticleNotFound", (e) => Effect.succeed(`caught ${e.id}`))
      )
    )
    expect(recovered).toBe("caught 42")
  })

  it("exposes status / code / title statics", () => {
    expect(ArticleNotFound.status).toBe(404)
    expect(ArticleNotFound.code).toBe("not_found")
    expect(ArticleNotFound.title).toBe("Resource not found")
  })

  it("defaults code to the snake_cased tag", () => {
    expect(TitleTaken.code).toBe("title_taken")
    expect(RateLimited.code).toBe("rate_limited")
  })

  it("encodes to a spec-compliant JSON:API error document", () => {
    const wire = Schema.encodeUnknownSync(ArticleNotFound.wire)(new ArticleNotFound({ id: "42" }))
    expect(wire).toEqual({
      errors: [
        {
          status: "404",
          code: "not_found",
          title: "Resource not found",
          detail: "Article 42 not found",
          meta: { id: "42" }
        }
      ]
    })
  })

  it("decodes a JSON:API error document back into an instance of the class", () => {
    const document = {
      errors: [
        {
          status: "404",
          code: "not_found",
          title: "Resource not found",
          detail: "Article 42 not found",
          meta: { id: "42" }
        }
      ]
    }
    const error = Schema.decodeUnknownSync(ArticleNotFound.wire)(document)
    expect(error).toBeInstanceOf(ArticleNotFound)
    expect((error as ArticleNotFound).id).toBe("42")
  })

  it("round-trips errors without fields", () => {
    const wire = Schema.encodeUnknownSync(RateLimited.wire)(new RateLimited())
    expect(wire).toEqual({
      errors: [{ status: "429", code: "rate_limited", title: "Too Many Requests" }]
    })
    const error = Schema.decodeUnknownSync(RateLimited.wire)(wire)
    expect(error).toBeInstanceOf(RateLimited)
  })

  it("memoizes the wire schema per class", () => {
    expect(ArticleNotFound.wire).toBe(ArticleNotFound.wire)
  })

  it("types the wire schema's Type as the error class", () => {
    expectTypeOf<typeof ArticleNotFound.wire.Type>().toEqualTypeOf<ArticleNotFound>()
  })
})

describe("standard errors", () => {
  it("declares the content-negotiation and bad-request errors", () => {
    expect(ApiError.BadRequest.status).toBe(400)
    expect(ApiError.NotAcceptable.status).toBe(406)
    expect(ApiError.UnsupportedMediaType.status).toBe(415)
    expect(ApiError.Standard).toHaveLength(3)
  })

  it("BadRequest carries an optional detail", () => {
    const wire = Schema.encodeUnknownSync(ApiError.BadRequest.wire)(
      new ApiError.BadRequest({ detail: "missing data member" })
    )
    expect(wire).toEqual({
      errors: [
        {
          status: "400",
          code: "bad_request",
          title: "Bad Request",
          detail: "missing data member",
          meta: { detail: "missing data member" }
        }
      ]
    })
  })

  it("BadRequest omits detail when not provided", () => {
    const wire = Schema.encodeUnknownSync(ApiError.BadRequest.wire)(new ApiError.BadRequest({}))
    expect(wire).toEqual({
      errors: [{ status: "400", code: "bad_request", title: "Bad Request", meta: {} }]
    })
  })

  it("UnsupportedMediaType encodes to a 415 error document", () => {
    const wire = Schema.encodeUnknownSync(ApiError.UnsupportedMediaType.wire)(new ApiError.UnsupportedMediaType())
    expect(wire).toEqual({
      errors: [{ status: "415", code: "unsupported_media_type", title: "Unsupported Media Type" }]
    })
  })

  it("Forbidden and Conflict are available for application use", () => {
    expect(ApiError.Forbidden.status).toBe(403)
    expect(ApiError.Conflict.status).toBe(409)
  })
})

describe("ApiError.toDocument", () => {
  it("encodes an error instance to a JSON:API error document, no HttpApi", () => {
    const document = ApiError.toDocument(new ArticleNotFound({ id: "42" }))
    expect(document).toEqual({
      errors: [
        {
          status: "404",
          code: "not_found",
          title: "Resource not found",
          detail: "Article 42 not found",
          meta: { id: "42" }
        }
      ]
    })
  })

  it("works for a standard error (e.g. for a content-negotiation failure)", () => {
    expect(ApiError.toDocument(new ApiError.UnsupportedMediaType())).toEqual({
      errors: [{ status: "415", code: "unsupported_media_type", title: "Unsupported Media Type" }]
    })
    expect(ApiError.toDocument(new ApiError.BadRequest({ detail: "bad query" }))).toEqual({
      errors: [
        { status: "400", code: "bad_request", title: "Bad Request", detail: "bad query", meta: { detail: "bad query" } }
      ]
    })
  })

  it("throws when given a value that is not an ApiError instance", () => {
    expect(() => ApiError.toDocument({ notAnError: true })).toThrow()
  })
})
