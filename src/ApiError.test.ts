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

  it("BadRequest decodes a document carrying detail on the error object but no meta", () => {
    // the schema-error middleware's source-bearing 400s, and any other server's
    const decoded = Schema.decodeUnknownSync(ApiError.BadRequest.wire)({
      errors: [
        {
          status: "400",
          code: "bad_request",
          title: "Bad Request",
          detail: 'Unknown filter field "body"',
          source: { parameter: "filter[body]" }
        }
      ]
    })
    expect(decoded).toBeInstanceOf(ApiError.BadRequest)
    expect(decoded.detail).toBe('Unknown filter field "body"')
    // without detail anywhere the field is simply absent
    expect(
      Schema.decodeUnknownSync(ApiError.BadRequest.wire)({ errors: [{ status: "400", code: "bad_request" }] }).detail
    ).toBeUndefined()
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

describe("query-parameter errors", () => {
  it("UnsupportedIncludePath encodes the requested path and the includable set into meta", () => {
    const error = new ApiError.UnsupportedIncludePath({
      path: "author.employer",
      includablePaths: ["author", "comments", "comments.author"]
    })
    const wire = Schema.encodeUnknownSync(ApiError.UnsupportedIncludePath.wire)(error)
    expect(wire).toEqual({
      errors: [
        {
          status: "400",
          code: "unsupported.include-path",
          title: "Unsupported Include Path",
          detail: 'Include path "author.employer" is not supported; supported paths: author, comments, comments.author',
          meta: { path: "author.employer", includablePaths: ["author", "comments", "comments.author"] }
        }
      ]
    })
  })

  it("UnsupportedIncludePath meta round-trips through the wire schema", () => {
    const original = new ApiError.UnsupportedIncludePath({ path: "publisher", includablePaths: ["author"] })
    const wire = Schema.encodeUnknownSync(ApiError.UnsupportedIncludePath.wire)(original)
    const decoded = Schema.decodeUnknownSync(ApiError.UnsupportedIncludePath.wire)(wire)
    expect(decoded).toBeInstanceOf(ApiError.UnsupportedIncludePath)
    expect(decoded.path).toBe("publisher")
    expect(decoded.includablePaths).toEqual(["author"])
  })

  it("UnsupportedIncludePath reports an empty includable set readably", () => {
    const error = new ApiError.UnsupportedIncludePath({ path: "author", includablePaths: [] })
    const wire = Schema.encodeUnknownSync(ApiError.UnsupportedIncludePath.wire)(error)
    expect(wire.errors[0]?.detail).toBe('Include path "author" is not supported; supported paths: (none)')
  })

  it("UnsupportedIncludeDepth encodes the requested path and the depth cap into meta", () => {
    const error = new ApiError.UnsupportedIncludeDepth({ path: "comments.author.employer", maxDepth: 2 })
    const wire = Schema.encodeUnknownSync(ApiError.UnsupportedIncludeDepth.wire)(error)
    expect(wire).toEqual({
      errors: [
        {
          status: "400",
          code: "unsupported.include-depth",
          title: "Unsupported Include Depth",
          detail: 'Include path "comments.author.employer" exceeds the maximum include depth of 2',
          meta: { path: "comments.author.employer", maxDepth: 2 }
        }
      ]
    })
  })

  it("UnsupportedIncludeDepth meta round-trips through the wire schema", () => {
    const original = new ApiError.UnsupportedIncludeDepth({ path: "a.b.c", maxDepth: 2 })
    const wire = Schema.encodeUnknownSync(ApiError.UnsupportedIncludeDepth.wire)(original)
    const decoded = Schema.decodeUnknownSync(ApiError.UnsupportedIncludeDepth.wire)(wire)
    expect(decoded).toBeInstanceOf(ApiError.UnsupportedIncludeDepth)
    expect(decoded.path).toBe("a.b.c")
    expect(decoded.maxDepth).toBe(2)
  })

  it("UnsupportedSortField encodes the requested field and the sortable set into meta", () => {
    const error = new ApiError.UnsupportedSortField({
      field: "internalScore",
      sortableFields: ["title", "createdAt"]
    })
    const wire = Schema.encodeUnknownSync(ApiError.UnsupportedSortField.wire)(error)
    expect(wire).toEqual({
      errors: [
        {
          status: "400",
          code: "unsupported.sort-field",
          title: "Unsupported Sort Field",
          detail: 'Sort field "internalScore" is not supported; supported fields: title, createdAt',
          meta: { field: "internalScore", sortableFields: ["title", "createdAt"] }
        }
      ]
    })
  })

  it("UnsupportedSortField meta round-trips through the wire schema", () => {
    const original = new ApiError.UnsupportedSortField({ field: "score", sortableFields: ["title"] })
    const wire = Schema.encodeUnknownSync(ApiError.UnsupportedSortField.wire)(original)
    const decoded = Schema.decodeUnknownSync(ApiError.UnsupportedSortField.wire)(wire)
    expect(decoded).toBeInstanceOf(ApiError.UnsupportedSortField)
    expect(decoded.field).toBe("score")
    expect(decoded.sortableFields).toEqual(["title"])
  })

  it("UnsupportedFieldsetMember encodes the type, requested member and attributes into meta", () => {
    const error = new ApiError.UnsupportedFieldsetMember({
      type: "articles",
      field: "internalNotes",
      attributes: ["title", "body"]
    })
    const wire = Schema.encodeUnknownSync(ApiError.UnsupportedFieldsetMember.wire)(error)
    expect(wire).toEqual({
      errors: [
        {
          status: "400",
          code: "unsupported.fieldset",
          title: "Unsupported Fieldset Member",
          detail: 'Field "internalNotes" is not a supported attribute of "articles"; supported attributes: title, body',
          meta: { type: "articles", field: "internalNotes", attributes: ["title", "body"] }
        }
      ]
    })
  })

  it("UnsupportedFieldsetMember meta round-trips through the wire schema", () => {
    const original = new ApiError.UnsupportedFieldsetMember({
      type: "articles",
      field: "secret",
      attributes: ["title"]
    })
    const wire = Schema.encodeUnknownSync(ApiError.UnsupportedFieldsetMember.wire)(original)
    const decoded = Schema.decodeUnknownSync(ApiError.UnsupportedFieldsetMember.wire)(wire)
    expect(decoded).toBeInstanceOf(ApiError.UnsupportedFieldsetMember)
    expect(decoded.type).toBe("articles")
    expect(decoded.field).toBe("secret")
    expect(decoded.attributes).toEqual(["title"])
  })

  it("QueryParameterErrors carries all four query-parameter errors", () => {
    expect(ApiError.QueryParameterErrors).toHaveLength(4)
    expect(ApiError.QueryParameterErrors).toContain(ApiError.UnsupportedIncludePath)
    expect(ApiError.QueryParameterErrors).toContain(ApiError.UnsupportedIncludeDepth)
    expect(ApiError.QueryParameterErrors).toContain(ApiError.UnsupportedSortField)
    expect(ApiError.QueryParameterErrors).toContain(ApiError.UnsupportedFieldsetMember)
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
