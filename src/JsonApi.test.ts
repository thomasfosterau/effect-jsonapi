import { describe, expect, it } from "vitest"
import { Exit, Schema } from "effect"
import {
  AnyMeta,
  Article,
  ArticleApiDocument,
  ArticleDocument,
  Comment,
  CollectionDocument,
  DataDocument,
  ErrorDocument,
  ErrorObject,
  JsonApiError,
  Link,
  LinkObject,
  Person,
  RelationshipLinks,
  RelationshipLinksOpen,
  ResourceId,
  ResourceIdentifier,
  toMany,
  toOne
} from "./JsonApi.js"

// Typed helpers around the Schema codec API. The runtime call is identical to
// `Schema.decodeUnknownSync(schema)(input)`; we just want the static result
// type to flow through generics for ergonomic test assertions.
const decode = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(schema as unknown as Schema.Codec<S["Type"], unknown>)
const decodeStrict = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(
    schema as unknown as Schema.Codec<S["Type"], unknown>,
    { onExcessProperty: "error" }
  )
const encode = <S extends Schema.Top>(schema: S) =>
  Schema.encodeUnknownSync(schema as unknown as Schema.Codec<S["Type"], unknown>)

describe("Link", () => {
  it("accepts a bare URL string", () => {
    expect(decode(Link)("https://example.com")).toBe("https://example.com")
  })

  it("accepts the LinkObject form", () => {
    const input = { href: "https://example.com", title: "Home" }
    expect(decode(LinkObject)(input)).toEqual(input)
  })

  it("rejects a link object missing href", () => {
    expect(() => decode(Link)({ title: "missing href" })).toThrow()
  })
})

describe("ResourceId", () => {
  it("brands the id string with the resource type", () => {
    const articleId = ResourceId("articles")
    const value = articleId.make("123")
    // type-level: assignable to a `string & Brand<"articlesId">`
    const typecheck: typeof value = value
    expect(typecheck).toBe("123")
    expect(decode(articleId)("xyz")).toBe("xyz")
  })
})

describe("ResourceIdentifier", () => {
  it("round-trips type/id/meta", () => {
    const schema = ResourceIdentifier("articles")
    const decoded = decode(schema)({ type: "articles", id: "1", meta: { v: 1 } })
    expect(decoded).toMatchObject({ type: "articles", id: "1" })
    const back = encode(schema)(decoded)
    expect(back).toEqual({ type: "articles", id: "1", meta: { v: 1 } })
  })

  it("rejects the wrong type tag", () => {
    const schema = ResourceIdentifier("articles")
    expect(() => decode(schema)({ type: "comments", id: "1" })).toThrow()
  })
})

describe("Relationships", () => {
  it("toOne keeps `data` required and accepts null", () => {
    const schema = toOne("people")
    expect(decode(schema)({ data: null })).toEqual({ data: null })
    expect(decode(schema)({ data: { type: "people", id: "9" } })).toMatchObject({
      data: { type: "people", id: "9" }
    })
    expect(() => decode(schema)({})).toThrow()
  })

  it("toMany accepts an empty array and rejects bare null", () => {
    const schema = toMany("comments")
    expect(decode(schema)({ data: [] })).toEqual({ data: [] })
    expect(() => decode(schema)({ data: null })).toThrow()
  })
})

describe("RelationshipLinks variants", () => {
  it("closed RelationshipLinks rejects unknown keys with strict decoding", () => {
    expect(() =>
      decodeStrict(RelationshipLinks)({
        self: "https://example.com/self",
        weird: "no"
      })
    ).toThrow()
  })

  it("RelationshipLinksOpen accepts profile-defined extra keys", () => {
    const decoded = decode(RelationshipLinksOpen)({
      self: "https://example.com/self",
      related: "https://example.com/related",
      "https://profile.example.com/rel": null,
      "https://profile.example.com/other": { href: "https://x" }
    })
    expect(decoded.self).toBe("https://example.com/self")
    // profile-defined keys round-trip as `Link | null`
    expect(decoded["https://profile.example.com/rel"]).toBeNull()
  })
})

describe("ErrorObject and JsonApiError", () => {
  it("ErrorObject accepts any source variant", () => {
    expect(
      decode(ErrorObject)({
        status: "422",
        title: "Validation",
        source: { pointer: "/data/attributes/title" }
      })
    ).toMatchObject({ status: "422" })
    expect(
      decode(ErrorObject)({
        status: "400",
        source: { header: "Authorization" }
      })
    ).toMatchObject({ source: { header: "Authorization" } })
  })

  it("JsonApiError closes the code union", () => {
    const schema = JsonApiError(["title_taken", "forbidden", "not_found"])
    expect(decode(schema)({ code: "forbidden" })).toMatchObject({ code: "forbidden" })
    expect(() => decode(schema)({ code: "made_up" })).toThrow()
    expect(decode(schema)({})).toEqual({})
  })
})

describe("DataDocument", () => {
  const schema = DataDocument(Article)

  it("accepts a single resource", () => {
    const id = ResourceId("articles").make("1")
    const decoded = decode(schema)({
      data: {
        type: "articles",
        id,
        attributes: { title: "Hi", body: "x", createdAt: "2024-01-01T00:00:00.000Z" }
      }
    })
    expect(decoded.data).toMatchObject({ type: "articles", id })
  })

  it("accepts an array of resources", () => {
    const decoded = decode(schema)({ data: [] })
    expect(Array.isArray(decoded.data)).toBe(true)
  })

  it("accepts null primary data", () => {
    expect(decode(schema)({ data: null })).toEqual({ data: null })
  })
})

describe("CollectionDocument", () => {
  it("requires `data` to be an array", () => {
    const schema = CollectionDocument(Article)
    expect(decode(schema)({ data: [] }).data).toEqual([])
    expect(() => decode(schema)({ data: null })).toThrow()
    expect(() =>
      decode(schema)({
        data: {
          type: "articles",
          id: "1",
          attributes: { title: "x", body: "x", createdAt: "2024-01-01T00:00:00.000Z" }
        }
      })
    ).toThrow()
  })
})

describe("discriminated included union", () => {
  const schema = DataDocument(Article, Schema.Union([Person, Comment]))

  it("accepts a mixed included array keyed by `type`", () => {
    const decoded = decode(schema)({
      data: null,
      included: [
        {
          type: "people",
          id: "9",
          attributes: { firstName: "Ada", lastName: "Lovelace" }
        },
        {
          type: "comments",
          id: "5",
          attributes: { body: "nice post" },
          relationships: { author: { data: { type: "people", id: "9" } } }
        }
      ]
    })
    expect(decoded.included?.length).toBe(2)
  })

  it("rejects an unknown type tag in `included`", () => {
    expect(() =>
      decode(schema)({
        data: null,
        included: [
          {
            type: "aliens",
            id: "??",
            attributes: { color: "green" }
          }
        ]
      })
    ).toThrow()
  })
})

describe("ErrorDocument", () => {
  it("requires at least one error", () => {
    const schema = ErrorDocument(ErrorObject)
    expect(() => decode(schema)({ errors: [] })).toThrow()
    expect(
      decode(schema)({ errors: [{ status: "500", title: "Boom" }] }).errors.length
    ).toBe(1)
  })
})

describe("ArticleApiDocument round-trip via decodeUnknownExit", () => {
  it("succeeds for a valid data document", () => {
    const exit = Schema.decodeUnknownExit(ArticleApiDocument)({
      data: null
    })
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("succeeds for an error document with closed code", () => {
    const exit = Schema.decodeUnknownExit(ArticleApiDocument)({
      errors: [{ code: "not_found", status: "404", title: "Missing" }]
    })
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("rejects an error document with a wide-open code", () => {
    const exit = Schema.decodeUnknownExit(ArticleApiDocument)({
      errors: [{ code: "made_up", status: "500", title: "?" }]
    })
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("AnyMeta acts as the parameterized default", () => {
  it("decodes arbitrary records as meta", () => {
    const decoded = decode(AnyMeta)({ total: 12, page: { offset: 0 } })
    expect(decoded).toMatchObject({ total: 12 })
  })
})

describe("ArticleDocument typed pagination meta", () => {
  it("requires meta members to be Int", () => {
    expect(() =>
      decode(ArticleDocument)({
        data: null,
        meta: { total: 1.5, pageSize: 25 }
      })
    ).toThrow()
  })
})
