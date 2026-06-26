import { describe, expect, it } from "vitest"
import { NotAcceptable, UnsupportedMediaType } from "./ApiError.js"
import { acceptIsAcceptable, contentTypeIsAcceptable, negotiate } from "./Middleware.js"
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
})
