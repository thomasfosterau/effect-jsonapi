import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema } from "effect"
import * as Relationship from "./Relationship.js"
import { Resource } from "./Resource.js"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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

// A resource exercising all four relationship kinds.
const Article = Resource("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    author: Relationship.one(() => Person),
    editor: Relationship.optional(() => Person),
    comments: Relationship.many(() => Comment),
    revisions: Relationship.paginated(() => Comment)
  }
})

describe("Relationship constructors", () => {
  it("produce descriptors discriminated by kind", () => {
    expect(Relationship.one(() => Person).kind).toBe("one")
    expect(Relationship.optional(() => Person).kind).toBe("optional")
    expect(Relationship.many(() => Comment).kind).toBe("many")
    expect(Relationship.paginated(() => Comment).kind).toBe("paginated")
  })

  it("resolve their target through the thunk", () => {
    expect(Relationship.one(() => Person).ref().type).toBe("people")
    expect(Relationship.paginated(() => Comment).ref().type).toBe("comments")
  })
})

describe("Relationship predicates", () => {
  const one = Relationship.one(() => Person)
  const optional = Relationship.optional(() => Person)
  const many = Relationship.many(() => Comment)
  const paginated = Relationship.paginated(() => Comment)

  it("isLinkable: everything except paginated", () => {
    expect(Relationship.isLinkable(one)).toBe(true)
    expect(Relationship.isLinkable(optional)).toBe(true)
    expect(Relationship.isLinkable(many)).toBe(true)
    expect(Relationship.isLinkable(paginated)).toBe(false)
  })

  it("isToOne: one and optional", () => {
    expect(Relationship.isToOne(one)).toBe(true)
    expect(Relationship.isToOne(optional)).toBe(true)
    expect(Relationship.isToOne(many)).toBe(false)
    expect(Relationship.isToOne(paginated)).toBe(false)
  })

  it("isToMany: many and paginated", () => {
    expect(Relationship.isToMany(one)).toBe(false)
    expect(Relationship.isToMany(optional)).toBe(false)
    expect(Relationship.isToMany(many)).toBe(true)
    expect(Relationship.isToMany(paginated)).toBe(true)
  })
})

describe("Relationship wire schemas", () => {
  describe("one", () => {
    const schema = Relationship.schemaFor(Relationship.one(() => Person))

    it("accepts identifier linkage", () => {
      const decoded = Schema.decodeUnknownSync(schema)({ data: { type: "people", id: "9" } })
      expect(decoded.data).toEqual({ type: "people", id: "9" })
    })

    it("rejects null linkage (required relationship)", () => {
      expect(() => Schema.decodeUnknownSync(schema)({ data: null })).toThrow()
    })

    it("rejects missing data", () => {
      expect(() => Schema.decodeUnknownSync(schema)({})).toThrow()
    })

    it("rejects identifiers of the wrong type", () => {
      expect(() => Schema.decodeUnknownSync(schema)({ data: { type: "comments", id: "9" } })).toThrow()
    })

    it("accepts optional links and meta", () => {
      const decoded = Schema.decodeUnknownSync(schema)({
        data: { type: "people", id: "9" },
        links: { self: "/articles/1/relationships/author", related: "/articles/1/author" },
        meta: { count: 1 }
      })
      expect(decoded.links?.related).toBe("/articles/1/author")
      expect(decoded.meta?.count).toBe(1)
    })
  })

  describe("optional", () => {
    const schema = Relationship.schemaFor(Relationship.optional(() => Person))

    it("accepts identifier linkage", () => {
      const decoded = Schema.decodeUnknownSync(schema)({ data: { type: "people", id: "9" } })
      expect(decoded.data).toEqual({ type: "people", id: "9" })
    })

    it("accepts null linkage (empty relationship)", () => {
      const decoded = Schema.decodeUnknownSync(schema)({ data: null })
      expect(decoded.data).toBeNull()
    })

    it("rejects missing data", () => {
      expect(() => Schema.decodeUnknownSync(schema)({})).toThrow()
    })
  })

  describe("many", () => {
    const schema = Relationship.schemaFor(Relationship.many(() => Comment))

    it("accepts identifier array linkage", () => {
      const decoded = Schema.decodeUnknownSync(schema)({
        data: [{ type: "comments", id: "5" }, { type: "comments", id: "6" }]
      })
      expect(decoded.data).toHaveLength(2)
    })

    it("accepts an empty array", () => {
      expect(Schema.decodeUnknownSync(schema)({ data: [] }).data).toEqual([])
    })

    it("rejects null linkage", () => {
      expect(() => Schema.decodeUnknownSync(schema)({ data: null })).toThrow()
    })

    it("rejects a single identifier (must be an array)", () => {
      expect(() => Schema.decodeUnknownSync(schema)({ data: { type: "comments", id: "5" } })).toThrow()
    })
  })

  describe("paginated", () => {
    const schema = Relationship.schemaFor(Relationship.paginated(() => Comment))

    it("accepts links-only relationship objects (no data)", () => {
      const decoded = Schema.decodeUnknownSync(schema)({
        links: { related: "/articles/1/revisions" }
      })
      expect(decoded.links.related).toBe("/articles/1/revisions")
    })

    it("accepts a self link alongside related", () => {
      const decoded = Schema.decodeUnknownSync(schema)({
        links: {
          self: "/articles/1/relationships/revisions",
          related: "/articles/1/revisions"
        }
      })
      expect(decoded.links.self).toBe("/articles/1/relationships/revisions")
    })

    it("requires the related link", () => {
      expect(() => Schema.decodeUnknownSync(schema)({ links: { self: "/x" } })).toThrow()
      expect(() => Schema.decodeUnknownSync(schema)({})).toThrow()
    })

    it("has no data member in its type", () => {
      type Decoded = (typeof schema)["Type"]
      expectTypeOf<Decoded>().not.toHaveProperty("data")
    })

    it("accepts meta (e.g. a count) alongside links", () => {
      const decoded = Schema.decodeUnknownSync(schema)({
        links: { related: "/articles/1/revisions" },
        meta: { count: 412 }
      })
      expect(decoded.meta?.count).toBe(412)
    })
  })
})

describe("relationship kinds in resource objects", () => {
  it("decodes a resource exercising all four kinds", () => {
    const decoded = Schema.decodeUnknownSync(Article)({
      type: "articles",
      id: "1",
      attributes: { title: "Hello" },
      relationships: {
        author: { data: { type: "people", id: "9" } },
        editor: { data: null },
        comments: { data: [{ type: "comments", id: "5" }] },
        revisions: { links: { related: "/articles/1/revisions" } }
      }
    })
    expect(decoded.relationships?.author.data.id).toBe("9")
    expect(decoded.relationships?.editor.data).toBeNull()
    expect(decoded.relationships?.comments.data).toHaveLength(1)
    expect(decoded.relationships?.revisions.links.related).toBe("/articles/1/revisions")
  })

  it("rejects null linkage for a `one` relationship", () => {
    expect(() =>
      Schema.decodeUnknownSync(Article)({
        type: "articles",
        id: "1",
        attributes: { title: "Hello" },
        relationships: {
          author: { data: null },
          editor: { data: null },
          comments: { data: [] },
          revisions: { links: { related: "/articles/1/revisions" } }
        }
      })
    ).toThrow()
  })

  it("rejects inline data for a `paginated` relationship", () => {
    expect(() =>
      Schema.decodeUnknownSync(Article)(
        {
          type: "articles",
          id: "1",
          attributes: { title: "Hello" },
          relationships: {
            author: { data: { type: "people", id: "9" } },
            editor: { data: null },
            comments: { data: [] },
            // data is not part of the paginated schema; links are required
            revisions: { data: [{ type: "comments", id: "5" }] }
          }
        },
        { onExcessProperty: "error" }
      )
    ).toThrow()
  })

  it("types `one` linkage as non-nullable and `optional` linkage as nullable", () => {
    type Rels = NonNullable<typeof Article.Type["relationships"]>
    expectTypeOf<Rels["author"]["data"]>().toEqualTypeOf<typeof Person.identifier.Type>()
    expectTypeOf<Rels["editor"]["data"]>().toEqualTypeOf<typeof Person.identifier.Type | null>()
  })
})
