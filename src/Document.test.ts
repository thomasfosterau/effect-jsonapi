import { describe, expect, expectTypeOf, it } from "vitest"
import { Option, Schema } from "effect"
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

// ---------------------------------------------------------------------------
// JSON Pointer (RFC 6901) construction and parsing
// ---------------------------------------------------------------------------

describe("Document.pointer", () => {
  it("builds an attribute pointer", () => {
    expect(Document.pointer.attribute("title")).toBe("/data/attributes/title")
  })

  it("builds a relationship pointer", () => {
    expect(Document.pointer.relationship("author")).toBe("/data/relationships/author")
  })

  it("builds an indexed attribute pointer for a collection payload", () => {
    expect(Document.pointer.attribute("title", { index: 2 })).toBe("/data/2/attributes/title")
  })

  it("builds an indexed relationship pointer for a collection payload", () => {
    expect(Document.pointer.relationship("author", { index: 0 })).toBe("/data/0/relationships/author")
  })

  it("escapes ~ and / per RFC 6901", () => {
    expect(Document.pointer.escape("a~b")).toBe("a~0b")
    expect(Document.pointer.escape("a/b")).toBe("a~1b")
    expect(Document.pointer.escape("a~/b")).toBe("a~0~1b")
  })

  it("escapes a literal / in an attribute name", () => {
    expect(Document.pointer.attribute("a/b")).toBe("/data/attributes/a~1b")
  })
})

describe("Document.parsePointer", () => {
  it("parses an attribute pointer", () => {
    expect(Document.parsePointer("/data/attributes/title")).toEqual(Option.some({ _tag: "attribute", name: "title" }))
  })

  it("parses a relationship pointer", () => {
    expect(Document.parsePointer("/data/relationships/author")).toEqual(
      Option.some({ _tag: "relationship", name: "author" })
    )
  })

  it("parses an indexed attribute pointer", () => {
    expect(Document.parsePointer("/data/2/attributes/title")).toEqual(
      Option.some({ _tag: "attribute", name: "title", index: 2 })
    )
  })

  it("parses an indexed relationship pointer", () => {
    expect(Document.parsePointer("/data/0/relationships/author")).toEqual(
      Option.some({ _tag: "relationship", name: "author", index: 0 })
    )
  })

  it("round-trips every pointer() output back to the member it names", () => {
    expect(Document.parsePointer(Document.pointer.attribute("title"))).toEqual(
      Option.some({ _tag: "attribute", name: "title" })
    )
    expect(Document.parsePointer(Document.pointer.relationship("author", { index: 3 }))).toEqual(
      Option.some({ _tag: "relationship", name: "author", index: 3 })
    )
  })

  it("round-trips a field name containing a literal /, correctly unescaped", () => {
    const pointer = Document.pointer.attribute("a/b")
    expect(pointer).toBe("/data/attributes/a~1b")
    expect(Document.parsePointer(pointer)).toEqual(Option.some({ _tag: "attribute", name: "a/b" }))
  })

  it("round-trips a field name containing a literal ~", () => {
    const pointer = Document.pointer.attribute("a~b")
    expect(Document.parsePointer(pointer)).toEqual(Option.some({ _tag: "attribute", name: "a~b" }))
  })

  it("round-trips a field name containing both ~ and /, order-sensitively", () => {
    // `~1` must decode before `~0`, or a literal "~1" (tilde-one, not an
    // escape) would be misread as an escaped "/".
    const pointer = Document.pointer.attribute("~1")
    expect(pointer).toBe("/data/attributes/~01")
    expect(Document.parsePointer(pointer)).toEqual(Option.some({ _tag: "attribute", name: "~1" }))
  })

  it("returns None for a pointer with an empty final segment", () => {
    expect(Document.parsePointer("/data/attributes/")).toEqual(Option.none())
    expect(Document.parsePointer("/data/relationships/")).toEqual(Option.none())
  })

  it("returns None for non-member pointers", () => {
    expect(Document.parsePointer("/data/id")).toEqual(Option.none())
    expect(Document.parsePointer("/data/type")).toEqual(Option.none())
    expect(Document.parsePointer("/data")).toEqual(Option.none())
    expect(Document.parsePointer("/")).toEqual(Option.none())
    expect(Document.parsePointer("/meta/total")).toEqual(Option.none())
  })

  it("returns None for a pointer not starting with /", () => {
    expect(Document.parsePointer("data/attributes/title")).toEqual(Option.none())
    expect(Document.parsePointer("")).toEqual(Option.none())
  })

  it("returns None for a malformed indexed pointer", () => {
    expect(Document.parsePointer("/data/attributes/2/title")).toEqual(Option.none())
  })
})
