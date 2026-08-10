import { describe, expect, it } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { NotAcceptable, toDocument, UnsupportedMediaType } from "./ApiError.js"
import * as Endpoint from "./Endpoint.js"
import * as Group from "./Group.js"
import type { ContentNegotiation, SchemaErrors } from "./Middleware.js"
import {
  acceptIsAcceptable,
  contentTypeIsAcceptable,
  layer,
  layerHostNegotiated,
  negotiate,
  schemaError
} from "./Middleware.js"
import * as Query from "./Query.js"
import { make as Resource } from "./Resource.js"
import { MEDIA_TYPE } from "./internal/media.js"

describe("contentTypeIsAcceptable", () => {
  it("accepts a missing or plain JSON:API content type", () => {
    expect(contentTypeIsAcceptable(undefined)).toBe(true)
    expect(contentTypeIsAcceptable(MEDIA_TYPE)).toBe(true)
  })

  it("rejects the JSON:API media type with non ext/profile parameters", () => {
    expect(contentTypeIsAcceptable(`${MEDIA_TYPE}; charset=utf-8`)).toBe(false)
  })

  it("leaves other content types to the downstream decoder", () => {
    expect(contentTypeIsAcceptable("application/json; charset=utf-8")).toBe(true)
  })
})

describe("acceptIsAcceptable", () => {
  it("accepts wildcards and the bare media type", () => {
    expect(acceptIsAcceptable("*/*")).toBe(true)
    expect(acceptIsAcceptable(MEDIA_TYPE)).toBe(true)
  })

  it("rejects when every JSON:API instance carries bad parameters", () => {
    expect(acceptIsAcceptable(`${MEDIA_TYPE}; charset=utf-8`)).toBe(false)
  })
})

describe("Middleware.negotiate", () => {
  it("returns undefined for an acceptable request", () => {
    expect(negotiate({})).toBeUndefined()
    expect(negotiate({ contentType: MEDIA_TYPE, accept: MEDIA_TYPE })).toBeUndefined()
    expect(negotiate({ accept: "*/*" })).toBeUndefined()
  })

  it("returns a 415 UnsupportedMediaType for a bad content type", () => {
    const error = negotiate({ contentType: `${MEDIA_TYPE}; charset=utf-8` })
    expect(error).toBeInstanceOf(UnsupportedMediaType)
    expect(error?._tag).toBe("UnsupportedMediaType")
    expect(UnsupportedMediaType.status).toBe(415)
  })

  it("returns a 406 NotAcceptable for a bad accept header", () => {
    const error = negotiate({ accept: `${MEDIA_TYPE}; charset=utf-8` })
    expect(error).toBeInstanceOf(NotAcceptable)
    expect(error?._tag).toBe("NotAcceptable")
    expect(NotAcceptable.status).toBe(406)
  })

  it("checks content type before accept (415 wins)", () => {
    const error = negotiate({
      contentType: `${MEDIA_TYPE}; charset=utf-8`,
      accept: `${MEDIA_TYPE}; charset=utf-8`
    })
    expect(error).toBeInstanceOf(UnsupportedMediaType)
  })

  it("honours supported extensions", () => {
    const ext = "https://jsonapi.org/ext/atomic"
    expect(negotiate({ contentType: `${MEDIA_TYPE}; ext="${ext}"` }, { extensions: [ext] })).toBeUndefined()
    expect(negotiate({ contentType: `${MEDIA_TYPE}; ext="${ext}"` })).toBeInstanceOf(UnsupportedMediaType)
  })

  it("applies the extension list to the Accept header too", () => {
    const ext = "https://jsonapi.org/ext/atomic"
    expect(negotiate({ accept: `${MEDIA_TYPE}; ext="${ext}"` }, { extensions: [ext] })).toBeUndefined()
    expect(negotiate({ accept: `${MEDIA_TYPE}; ext="${ext}"` })).toBeInstanceOf(NotAcceptable)
  })

  it("composes with ApiError.toDocument to render the spec error body", () => {
    const error = negotiate({ contentType: `${MEDIA_TYPE}; charset=utf-8` })
    expect(error).toBeInstanceOf(UnsupportedMediaType)
    expect(toDocument(error!)).toEqual({
      errors: [{ status: "415", code: "unsupported_media_type", title: "Unsupported Media Type" }]
    })
  })
})

describe("Middleware.schemaError", () => {
  it("renders the JSON:API 400 for each request part", () => {
    expect(toDocument(schemaError("Query"))).toEqual({
      errors: [
        {
          status: "400",
          code: "bad_request",
          title: "Bad Request",
          detail: "Request query failed validation",
          meta: { detail: "Request query failed validation" }
        }
      ]
    })
    expect(schemaError("Payload").detail).toBe("Request payload failed validation")
    expect(schemaError("Params").detail).toBe("Request params failed validation")
  })
})

// ---------------------------------------------------------------------------
// Host-negotiated apis: the endpoint constructors without the package's §5
// ---------------------------------------------------------------------------

const Article = Resource("articles", { attributes: { title: Schema.NonEmptyString } })

const Api = HttpApi.make("blog").add(
  Group.make(Article, Endpoint.get(Article), Endpoint.list(Article, { page: Query.Page.Offset }))
)

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      Effect.succeed({ data: Article.make({ id: params.id, attributes: { title: "Hello" } }) })
    )
    .handle("list", () => Effect.succeed({ data: [] }))
)

// Drives the api as a real web handler, so arbitrary request headers reach the
// middleware exactly as they would in production.
const request = async (
  middlewareLayer: Layer.Layer<ContentNegotiation | SchemaErrors>,
  url: string,
  headers: Record<string, string> = {}
) => {
  // The api layer also advertises the platform services (`FileSystem`,
  // `HttpPlatform`, …) that multipart and file responses would need; none of
  // these endpoints use them, so the requirement is discharged by the cast
  // rather than by pulling in a platform package for the test.
  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(ArticlesLive),
    Layer.provide(middlewareLayer)
  ) as unknown as Layer.Layer<never, never, HttpRouter.HttpRouter>

  const { dispose, handler } = HttpRouter.toWebHandler(appLayer)
  try {
    const response = await handler(new Request(url, { headers }))
    return { status: response.status, body: (await response.json()) as any }
  } finally {
    await dispose()
  }
}

describe("Middleware.layerHostNegotiated", () => {
  const url = "http://localhost/articles/1"

  it("skips §5 for an Accept header the package's own negotiation would reject", async () => {
    // A host that admits `application/json` for its api: the live middleware
    // 406s it after the host's hook already accepted it.
    const withPackageNegotiation = await request(layer, url, { accept: "application/json" })
    expect(withPackageNegotiation.status).toBe(406)

    const hostNegotiated = await request(layerHostNegotiated, url, { accept: "application/json" })
    expect(hostNegotiated.status).toBe(200)
    expect(hostNegotiated.body.data).toMatchObject({ type: "articles", id: "1" })
  })

  it("skips §5 for a content type the package's own negotiation would reject", async () => {
    const contentType = `${MEDIA_TYPE}; charset=utf-8`
    expect((await request(layer, url, { "content-type": contentType })).status).toBe(415)
    expect((await request(layerHostNegotiated, url, { "content-type": contentType })).status).toBe(200)
  })

  it("keeps the JSON:API 400s — only content negotiation is delegated", async () => {
    const bad = "http://localhost/articles?page[limit]=not-a-number"
    const hostNegotiated = await request(layerHostNegotiated, bad)
    expect(hostNegotiated.status).toBe(400)
    expect(hostNegotiated.body).toEqual({
      errors: [
        {
          status: "400",
          code: "bad_request",
          title: "Bad Request",
          detail: "Request query failed validation",
          meta: { detail: "Request query failed validation" }
        }
      ]
    })
    // byte-identical to what the fully-negotiating layer returns
    expect(hostNegotiated).toEqual(await request(layer, bad))
  })

  it("serves ordinary JSON:API requests identically to Middleware.layer", async () => {
    const headers = { accept: MEDIA_TYPE }
    expect(await request(layerHostNegotiated, url, headers)).toEqual(await request(layer, url, headers))
  })
})
