import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema } from "effect"
import * as Query from "./Query.js"
import * as Relationship from "./Relationship.js"
import { make as Resource } from "./Resource.js"

const Person = Resource("people", {
  attributes: {
    firstName: Schema.NonEmptyString,
    lastName: Schema.NonEmptyString
  }
})

const Comment = Resource("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: { author: Relationship.one(() => Person) }
})

const Article = Resource("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    body: Schema.String,
    createdAt: Schema.DateFromString
  },
  relationships: {
    author: Relationship.one(() => Person),
    comments: Relationship.many(() => Comment)
  }
})

// A resource with a paginated relationship: excluded from include paths, but
// its target still gets sparse fieldsets.
const Feed = Resource("feeds", {
  attributes: { name: Schema.NonEmptyString },
  relationships: {
    owner: Relationship.one(() => Person),
    entries: Relationship.paginated(() => Article)
  }
})

describe("Query.Include", () => {
  const include = Query.Include(Article)

  it("decodes comma-separated relationship paths", () => {
    expect(Schema.decodeUnknownSync(include)("author,comments")).toEqual(["author", "comments"])
  })

  it("accepts nested paths from the relationship graph", () => {
    expect(Schema.decodeUnknownSync(include)("comments.author")).toEqual(["comments.author"])
  })

  it("rejects unknown include paths (→ 400)", () => {
    expect(() => Schema.decodeUnknownSync(include)("author,publisher")).toThrow()
    expect(() => Schema.decodeUnknownSync(include)("comments.likes")).toThrow()
  })

  it("encodes back to a comma-separated string", () => {
    expect(Schema.encodeUnknownSync(include)(["author", "comments.author"])).toBe("author,comments.author")
  })

  it("excludes paginated relationships from include paths (→ 400)", () => {
    const feedInclude = Query.Include(Feed)
    // `owner` is linkable; `entries` is paginated and cannot be included.
    expect(Schema.decodeUnknownSync(feedInclude)("owner")).toEqual(["owner"])
    expect(() => Schema.decodeUnknownSync(feedInclude)("entries")).toThrow()
    expect(() => Schema.decodeUnknownSync(feedInclude)("entries.author")).toThrow()
    // ... and paths *through* a paginated relationship don't exist either.
    type FeedPaths = typeof feedInclude.Type
    expectTypeOf<FeedPaths>().toEqualTypeOf<ReadonlyArray<"owner">>()
  })
})

describe("Query.Fieldset", () => {
  const fieldset = Query.Fieldset(Article)

  it("decodes attribute names", () => {
    expect(Schema.decodeUnknownSync(fieldset)("title,body")).toEqual(["title", "body"])
  })

  it("rejects unknown attribute names (→ 400)", () => {
    expect(() => Schema.decodeUnknownSync(fieldset)("title,publisher")).toThrow()
  })

  it("types the decoded fields as attribute-key literals", () => {
    type Decoded = typeof fieldset.Type
    expectTypeOf<Decoded>().toEqualTypeOf<ReadonlyArray<"title" | "body" | "createdAt">>()
  })
})

describe("Query.Sort", () => {
  const sort = Query.Sort(["createdAt", "title"])

  it("decodes sort terms with direction prefixes", () => {
    expect(Schema.decodeUnknownSync(sort)("-createdAt,title")).toEqual([
      { field: "createdAt", direction: "desc" },
      { field: "title", direction: "asc" }
    ])
  })

  it("rejects unknown sort fields (→ 400)", () => {
    expect(() => Schema.decodeUnknownSync(sort)("body")).toThrow()
  })

  it("encodes sort terms back to the wire form", () => {
    expect(
      Schema.encodeUnknownSync(sort)([
        { field: "createdAt", direction: "desc" },
        { field: "title", direction: "asc" }
      ])
    ).toBe("-createdAt,title")
  })
})

describe("Query.schema", () => {
  const query = Query.schema(Article, {
    include: true,
    fields: true,
    sort: true,
    page: Query.Page.Offset,
    filter: { author: Schema.String }
  })

  it("decodes a full flat query into the nested ergonomic shape", () => {
    const decoded = Schema.decodeUnknownSync(query)({
      include: "author,comments.author",
      "fields[articles]": "title,body",
      "fields[people]": "firstName",
      sort: "-createdAt",
      "page[offset]": "20",
      "page[limit]": "10",
      "filter[author]": "9"
    })
    expect(decoded).toEqual({
      include: ["author", "comments.author"],
      fields: { articles: ["title", "body"], people: ["firstName"] },
      sort: [{ field: "createdAt", direction: "desc" }],
      page: { offset: 20, limit: 10 },
      filter: { author: "9" }
    })
  })

  it("decodes an empty query (all features optional)", () => {
    expect(Schema.decodeUnknownSync(query)({})).toEqual({})
  })

  it("decodes partial queries", () => {
    const decoded = Schema.decodeUnknownSync(query)({ "page[limit]": "5" })
    expect(decoded).toEqual({ page: { limit: 5 } })
  })

  it("rejects unknown include paths in the combined schema", () => {
    expect(() => Schema.decodeUnknownSync(query)({ include: "publisher" })).toThrow()
  })

  it("rejects unknown sparse fieldsets", () => {
    expect(() => Schema.decodeUnknownSync(query)({ "fields[articles]": "secret" })).toThrow()
  })

  it("rejects non-numeric page parameters", () => {
    expect(() => Schema.decodeUnknownSync(query)({ "page[offset]": "abc" })).toThrow()
  })

  it("encodes the nested shape back to flat wire parameters (client side)", () => {
    const encoded = Schema.encodeUnknownSync(query)({
      include: ["author"],
      fields: { articles: ["title"] },
      sort: [{ field: "createdAt", direction: "desc" }],
      page: { offset: 0, limit: 10 },
      filter: { author: "9" }
    })
    expect(encoded).toEqual({
      include: "author",
      "fields[articles]": "title",
      sort: "-createdAt",
      "page[offset]": "0",
      "page[limit]": "10",
      "filter[author]": "9"
    })
  })

  it("types the decoded query shape", () => {
    type Decoded = typeof query.Type
    // include paths are typed literals derived from the relationship graph
    expectTypeOf<Decoded["include"]>().toEqualTypeOf<
      ReadonlyArray<"author" | "comments" | "comments.author"> | undefined
    >()
    expectTypeOf<NonNullable<Decoded["fields"]>["articles"]>().toEqualTypeOf<
      ReadonlyArray<"title" | "body" | "createdAt"> | undefined
    >()
    expectTypeOf<NonNullable<Decoded["fields"]>["people"]>().toEqualTypeOf<
      ReadonlyArray<"firstName" | "lastName"> | undefined
    >()
    expectTypeOf<NonNullable<Decoded["page"]>["offset"]>().toEqualTypeOf<number | undefined>()
    expectTypeOf<NonNullable<Decoded["sort"]>[number]["field"]>().toEqualTypeOf<"title" | "body" | "createdAt">()
    expectTypeOf<NonNullable<Decoded["filter"]>["author"]>().toEqualTypeOf<string>()
  })

  it("supports restricted sort fields", () => {
    const restricted = Query.schema(Article, { sort: ["createdAt"] })
    expect(Schema.decodeUnknownSync(restricted)({ sort: "-createdAt" })).toEqual({
      sort: [{ field: "createdAt", direction: "desc" }]
    })
    expect(() => Schema.decodeUnknownSync(restricted)({ sort: "title" })).toThrow()
    type Decoded = typeof restricted.Type
    expectTypeOf<NonNullable<Decoded["sort"]>[number]["field"]>().toEqualTypeOf<"createdAt">()
  })

  it("builds an empty schema when no features are enabled", () => {
    const empty = Query.schema(Article, {})
    expect(Schema.decodeUnknownSync(empty)({})).toEqual({})
  })

  it("paginated targets still get sparse fieldsets (their related endpoint uses them)", () => {
    const feedQuery = Query.schema(Feed, { include: true, fields: true })
    const decoded = Schema.decodeUnknownSync(feedQuery)({
      "fields[feeds]": "name",
      "fields[people]": "firstName",
      // Article is only reachable via the paginated `entries` relationship,
      // but its fieldset is still configurable.
      "fields[articles]": "title"
    })
    expect(decoded).toEqual({
      fields: { feeds: ["name"], people: ["firstName"], articles: ["title"] }
    })
    // ... while `entries` remains invalid as an include path.
    expect(() => Schema.decodeUnknownSync(feedQuery)({ include: "entries" })).toThrow()
  })
})

describe("Query.Page", () => {
  it("provides offset, number and cursor strategies", () => {
    expect(Object.keys(Query.Page.Offset)).toEqual(["offset", "limit"])
    expect(Object.keys(Query.Page.Number)).toEqual(["number", "size"])
    expect(Object.keys(Query.Page.Cursor)).toEqual(["cursor", "size"])
  })

  it("number strategy decodes page[number]/page[size]", () => {
    const query = Query.schema(Article, { page: Query.Page.Number })
    const decoded = Schema.decodeUnknownSync(query)({ "page[number]": "2", "page[size]": "25" })
    expect(decoded).toEqual({ page: { number: 2, size: 25 } })
  })

  it("cursor strategy keeps the cursor opaque", () => {
    const query = Query.schema(Article, { page: Query.Page.Cursor })
    const decoded = Schema.decodeUnknownSync(query)({ "page[cursor]": "opaque-token" })
    expect(decoded).toEqual({ page: { cursor: "opaque-token" } })
  })
})

describe("Query.Page.offset (factory)", () => {
  it("produces the same { offset, limit } shape as the constant", () => {
    expect(Object.keys(Query.Page.offset())).toEqual(["offset", "limit"])
  })

  it("fromString: false decodes a plain number and rejects a numeric string", () => {
    const page = Schema.Struct(Query.Page.offset({ fromString: false }))
    expect(Schema.decodeUnknownSync(page)({ offset: 0, limit: 50 })).toEqual({ offset: 0, limit: 50 })
    expect(() => Schema.decodeUnknownSync(page)({ limit: "50" })).toThrow()
  })

  it("fromString: true (default) decodes a numeric string and rejects a plain number", () => {
    const page = Schema.Struct(Query.Page.offset())
    expect(Schema.decodeUnknownSync(page)({ offset: "0", limit: "50" })).toEqual({ offset: 0, limit: 50 })
    expect(() => Schema.decodeUnknownSync(page)({ limit: 50 })).toThrow()
  })

  it("maxLimit rejects maxLimit + 1 and accepts maxLimit", () => {
    const page = Schema.Struct(Query.Page.offset({ maxLimit: 100, fromString: false }))
    expect(Schema.decodeUnknownSync(page)({ limit: 100 })).toEqual({ limit: 100 })
    expect(() => Schema.decodeUnknownSync(page)({ limit: 101 })).toThrow()
  })

  it("minLimit defaults to 1 (rejects 0) and is configurable", () => {
    const dflt = Schema.Struct(Query.Page.offset({ fromString: false }))
    expect(() => Schema.decodeUnknownSync(dflt)({ limit: 0 })).toThrow()
    expect(Schema.decodeUnknownSync(dflt)({ limit: 1 })).toEqual({ limit: 1 })

    const floored = Schema.Struct(Query.Page.offset({ minLimit: 10, fromString: false }))
    expect(() => Schema.decodeUnknownSync(floored)({ limit: 9 })).toThrow()
    expect(Schema.decodeUnknownSync(floored)({ limit: 10 })).toEqual({ limit: 10 })
  })

  it("defaultLimit/defaultOffset fill in on an absent key", () => {
    const withDefaults = Schema.Struct(Query.Page.offset({ defaultLimit: 25, defaultOffset: 0, fromString: false }))
    expect(Schema.decodeUnknownSync(withDefaults)({})).toEqual({ offset: 0, limit: 25 })
    // a present key still wins over the default
    expect(Schema.decodeUnknownSync(withDefaults)({ limit: 10 })).toEqual({ offset: 0, limit: 10 })
  })

  it("encodes a string default for a string-coercing field (fromString: true)", () => {
    // withDecodingDefaultKey takes the *encoded* default, so the string field
    // must default through a string and still decode to a number.
    const page = Schema.Struct(Query.Page.offset({ defaultLimit: 25 }))
    expect(Schema.decodeUnknownSync(page)({})).toEqual({ limit: 25 })
  })

  it("omitting a default leaves the field optionalKey (absent → undefined)", () => {
    const page = Schema.Struct(Query.Page.offset({ fromString: false }))
    expect(Schema.decodeUnknownSync(page)({})).toEqual({})
  })

  it("rejects negative offsets and non-integers on both fields", () => {
    const page = Schema.Struct(Query.Page.offset({ fromString: false }))
    expect(() => Schema.decodeUnknownSync(page)({ offset: -1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(page)({ offset: 1.5 })).toThrow()
    expect(() => Schema.decodeUnknownSync(page)({ limit: 2.5 })).toThrow()
  })

  it("slots into Query.schema as a drop-in for the constant, carrying its bound", () => {
    const query = Query.schema(Article, { page: Query.Page.offset({ maxLimit: 100 }) })
    expect(Schema.decodeUnknownSync(query)({ "page[offset]": "20", "page[limit]": "10" })).toEqual({
      page: { offset: 20, limit: 10 }
    })
    expect(() => Schema.decodeUnknownSync(query)({ "page[limit]": "101" })).toThrow()
  })

  it("types a defaulted field as required and an un-defaulted field as optional", () => {
    const page = Schema.Struct(Query.Page.offset({ defaultLimit: 50, fromString: false }))
    type Decoded = typeof page.Type
    expectTypeOf<Decoded["offset"]>().toEqualTypeOf<number | undefined>()
    expectTypeOf<Decoded["limit"]>().toEqualTypeOf<number>()
    expectTypeOf<Decoded>().toEqualTypeOf<{ readonly offset?: number; readonly limit: number }>()

    // with fromString: true the *encoded* (wire) shape is strings
    const wire = Schema.Struct(Query.Page.offset({ defaultLimit: 50 }))
    type Encoded = typeof wire.Encoded
    expectTypeOf<Encoded["limit"]>().toEqualTypeOf<string | undefined>()
  })
})

describe("Query.Page.number (factory)", () => {
  it("produces the { number, size } shape and decodes", () => {
    expect(Object.keys(Query.Page.number())).toEqual(["number", "size"])
    const page = Schema.Struct(Query.Page.number({ fromString: false }))
    expect(Schema.decodeUnknownSync(page)({ number: 2, size: 25 })).toEqual({ number: 2, size: 25 })
  })

  it("treats page numbers as 1-based (rejects 0)", () => {
    const page = Schema.Struct(Query.Page.number({ fromString: false }))
    expect(() => Schema.decodeUnknownSync(page)({ number: 0 })).toThrow()
    expect(Schema.decodeUnknownSync(page)({ number: 1 })).toEqual({ number: 1 })
  })

  it("bounds and defaults the size field", () => {
    const page = Schema.Struct(Query.Page.number({ maxSize: 50, defaultSize: 10, fromString: false }))
    expect(Schema.decodeUnknownSync(page)({})).toEqual({ size: 10 })
    expect(() => Schema.decodeUnknownSync(page)({ size: 51 })).toThrow()
  })
})
