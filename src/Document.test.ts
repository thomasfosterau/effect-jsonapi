import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema } from "effect"
import * as Document from "./Document.js"

// ---------------------------------------------------------------------------
// Url codec
// ---------------------------------------------------------------------------

describe("Url", () => {
  const decode = Schema.decodeUnknownSync(Document.Url)
  const encode = Schema.encodeUnknownSync(Document.Url)

  it("decodes an absolute reference to a real URL", () => {
    const url = decode("https://example.com/articles/1?page[offset]=10")
    expect(url).toBeInstanceOf(URL)
    expect((url as URL).host).toBe("example.com")
    expect((url as URL).pathname).toBe("/articles/1")
  })

  it("leaves a relative reference as a string", () => {
    // JSON:API permits relative URI-references; `URL` cannot represent them, so
    // they pass through unchanged.
    expect(decode("/articles/1")).toBe("/articles/1")
  })

  it("rejects non-string input", () => {
    expect(() => decode(42)).toThrow()
  })

  it("round-trips both decoded forms back to the original wire string", () => {
    expect(encode(new URL("https://example.com/b"))).toBe("https://example.com/b")
    expect(encode("/articles/1")).toBe("/articles/1")
    // A bare absolute string (e.g. one a handler emitted) stays a string.
    expect(encode("https://example.com/c")).toBe("https://example.com/c")
  })

  it("has decoded type `URL | string`", () => {
    expectTypeOf<typeof Document.Url.Type>().toEqualTypeOf<URL | string>()
    expectTypeOf<typeof Document.Url.Encoded>().toEqualTypeOf<string>()
  })
})

// ---------------------------------------------------------------------------
// Links carry the Url codec through
// ---------------------------------------------------------------------------

describe("links decode URLs", () => {
  it("TopLevelLinks decodes absolute members to URL and keeps relative ones as strings", () => {
    const links = Schema.decodeUnknownSync(Document.TopLevelLinks)({
      self: "/articles?page[offset]=0",
      related: "https://example.com/articles",
      next: null
    })
    expect(links.self).toBe("/articles?page[offset]=0")
    expect(links.related).toBeInstanceOf(URL)
    expect(links.next).toBeNull()
  })

  it("a LinkObject's href and describedby decode to URLs", () => {
    const link = Schema.decodeUnknownSync(Document.LinkObject)({
      href: "https://example.com/articles/1",
      describedby: "https://example.com/schema.json",
      title: "Article"
    })
    expect(link.href).toBeInstanceOf(URL)
    expect(link.describedby).toBeInstanceOf(URL)
    expect(link.title).toBe("Article")
  })
})

// ---------------------------------------------------------------------------
// jsonapi object ext / profile are URIs
// ---------------------------------------------------------------------------

describe("JsonApiObject ext/profile", () => {
  it("decodes ext and profile URIs to URLs", () => {
    const jsonapi = Schema.decodeUnknownSync(Document.JsonApiObject)({
      version: "1.1",
      ext: ["https://jsonapi.org/ext/atomic"],
      profile: ["https://example.com/profiles/timestamps"]
    })
    expect(jsonapi.ext?.[0]).toBeInstanceOf(URL)
    expect(jsonapi.profile?.[0]).toBeInstanceOf(URL)
    // Re-encoding restores the wire strings.
    expect(Schema.encodeUnknownSync(Document.JsonApiObject)(jsonapi)).toEqual({
      version: "1.1",
      ext: ["https://jsonapi.org/ext/atomic"],
      profile: ["https://example.com/profiles/timestamps"]
    })
  })
})
