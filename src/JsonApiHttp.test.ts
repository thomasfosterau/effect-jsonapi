import { describe, expect, it } from "vitest"
import { Cause, Effect, Exit, Result, Schema } from "effect"
import { HttpApiTest } from "effect/unstable/httpapi"
import { Article, ErrorDocument, ErrorObject } from "./JsonApi.js"
import {
  Api,
  ArticleNotFound,
  ArticlesLive,
  BadRequest,
  errorResponse,
  JSONAPI_MEDIA_TYPE,
  sampleArticle
} from "./JsonApiHttp.js"
import {
  acceptIsAcceptable,
  contentTypeIsAcceptable
} from "./JsonApiMiddleware.js"

const ErrDoc = ErrorDocument(ErrorObject)

describe("errorResponse round-trip", () => {
  const NotFoundResponse = errorResponse(
    ArticleNotFound,
    404,
    (e) => ({
      errors: [{
        status: "404",
        code: "not_found",
        title: "Resource not found",
        detail: `Article ${e.id} not found`,
        meta: { id: e.id }
      }]
    }),
    (doc) => new ArticleNotFound({ id: String(doc.errors[0]?.meta?.id ?? "") })
  )

  it("encodes a tagged error to a JSON:API document", () => {
    const wire = Schema.encodeUnknownSync(NotFoundResponse)(new ArticleNotFound({ id: "42" }))
    expect(wire).toMatchObject({
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

  it("decodes a JSON:API document back to a tagged error preserving meta", () => {
    const document = {
      errors: [{
        status: "404",
        code: "not_found",
        title: "Resource not found",
        detail: "Article 42 not found",
        meta: { id: "42" }
      }]
    }
    const error = Schema.decodeUnknownSync(NotFoundResponse)(document) as ArticleNotFound
    expect(error).toBeInstanceOf(ArticleNotFound)
    expect(error.id).toBe("42")
  })
})

const findFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const r = Cause.findError(cause)
  return Result.isSuccess(r) ? r.success : undefined
}

describe("HTTP round-trip via HttpApiTest", () => {
  const buildClient = HttpApiTest.groups(Api, ["articles"])

  it("returns the sample article through the derived client", async () => {
    const program = Effect.gen(function* () {
      const client = yield* buildClient
      return yield* client.articles.getArticle({ params: { id: "1" } })
    }).pipe(Effect.scoped, Effect.provide(ArticlesLive))

    const result = await Effect.runPromise(program as Effect.Effect<any, any, never>)

    expect(result.data).toMatchObject({
      type: "articles",
      id: sampleArticle.id
    })
    // `data` is a `DataDocument`; the resource is decoded with the branded id.
    if (result.data !== null && !Array.isArray(result.data)) {
      const id: typeof Article.Type.id = result.data.id
      expect(id).toBe(sampleArticle.id)
    }
  })

  it("surfaces ArticleNotFound when the id is unknown", async () => {
    const program = Effect.gen(function* () {
      const client = yield* buildClient
      return yield* client.articles.getArticle({ params: { id: "does-not-exist" } })
    }).pipe(Effect.scoped, Effect.provide(ArticlesLive))

    const exit = await Effect.runPromiseExit(program as Effect.Effect<any, any, never>)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = findFailure(exit.cause)
      expect(error).toBeInstanceOf(ArticleNotFound)
      // The id round-trips through the document's meta.
      expect((error as ArticleNotFound).id).toBe("does-not-exist")
    }
  })
})

describe("Content-negotiation predicates", () => {
  // Drives the middleware's decision logic directly. This is the strongest
  // assertion we can make without spinning a real socket; the test for the
  // middleware wired into an `HttpApi` is the round-trip test above (happy
  // path), since the in-memory `HttpApiTest` client does not expose a hook to
  // mutate request headers per-call.

  it("contentTypeIsAcceptable: unparameterised JSON:API is OK", () => {
    expect(contentTypeIsAcceptable(undefined)).toBe(true)
    expect(contentTypeIsAcceptable("application/vnd.api+json")).toBe(true)
    expect(contentTypeIsAcceptable("application/json")).toBe(true)
  })

  it("contentTypeIsAcceptable: parameterised JSON:API → 415", () => {
    expect(contentTypeIsAcceptable("application/vnd.api+json; charset=utf-8")).toBe(false)
    expect(contentTypeIsAcceptable("APPLICATION/VND.API+JSON; profile=\"x\"")).toBe(false)
  })

  it("acceptIsAcceptable: missing or wildcard is OK", () => {
    expect(acceptIsAcceptable(undefined)).toBe(true)
    expect(acceptIsAcceptable("*/*")).toBe(true)
    expect(acceptIsAcceptable("application/*")).toBe(true)
  })

  it("acceptIsAcceptable: unparameterised JSON:API among alternatives is OK", () => {
    expect(acceptIsAcceptable("application/vnd.api+json")).toBe(true)
    expect(
      acceptIsAcceptable("application/vnd.api+json; profile=\"x\", application/vnd.api+json")
    ).toBe(true)
  })

  it("acceptIsAcceptable: only parameterised JSON:API → 406", () => {
    expect(acceptIsAcceptable("application/vnd.api+json; profile=\"x\"")).toBe(false)
  })

  it("acceptIsAcceptable: no JSON:API alternative → 406", () => {
    expect(acceptIsAcceptable("text/html")).toBe(false)
    expect(acceptIsAcceptable("application/json")).toBe(false)
  })
})

describe("Standard error documents are wire-shaped", () => {
  it("UnsupportedMediaType encodes to a 415 JSON:API errors document", () => {
    const wire = Schema.encodeUnknownSync(ErrDoc)({
      errors: [{
        status: "415",
        code: "unsupported_media_type",
        title: "Unsupported Media Type"
      }]
    })
    expect(wire.errors[0]).toMatchObject({
      status: "415",
      code: "unsupported_media_type"
    })
  })

  it("NotAcceptable encodes to a 406 JSON:API errors document", () => {
    const wire = Schema.encodeUnknownSync(ErrDoc)({
      errors: [{
        status: "406",
        code: "not_acceptable",
        title: "Not Acceptable"
      }]
    })
    expect(wire.errors[0]).toMatchObject({
      status: "406",
      code: "not_acceptable"
    })
  })

  it("BadRequest is a tagged error class", () => {
    const e = new BadRequest({ detail: "missing data" })
    expect(e._tag).toBe("BadRequest")
    expect(e.detail).toBe("missing data")
  })

  it("declares the JSON:API content type constant", () => {
    expect(JSONAPI_MEDIA_TYPE).toBe("application/vnd.api+json")
  })
})

describe("Api wiring", () => {
  it("exposes the articles group", () => {
    const groupNames = Object.keys((Api as any).groups ?? {})
    expect(groupNames).toContain("articles")
  })
})
