import { describe, expect, expectTypeOf, it } from "vitest"
import { Option, Schema } from "effect"
import { AnyMeta, CollectionDocument, DataDocument } from "./Document.js"
import * as Relationship from "./Relationship.js"
import {
  attributeAnnotations,
  attributeKeys,
  attributes as attributesOf,
  directTargets,
  extend,
  Identifier,
  make as Resource,
  readOnlyAttribute,
  relationships as relationshipsOf
} from "./Resource.js"

// ---------------------------------------------------------------------------
// Test fixtures: a small resource graph (DAG ordering: Person ← Comment ← Article)
// ---------------------------------------------------------------------------

const Person = Resource("people", {
  attributes: {
    firstName: Schema.NonEmptyString,
    lastName: Schema.NonEmptyString
  }
})

// A comment always has an author — `one`, required everywhere.
const Comment = Resource("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: { author: Relationship.one(() => Person) }
})

// An article's author is nullable (`optional`), its comments are inlined (`many`).
const Article = Resource("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    body: Schema.String,
    createdAt: Schema.DateFromString
  },
  relationships: {
    author: Relationship.optional(() => Person),
    comments: Relationship.many(() => Comment)
  },
  meta: Schema.Struct({ rank: Schema.Int })
})

// A resource with a required to-one and an unbounded (paginated) to-many.
const Author = Resource("authors", {
  attributes: { name: Schema.NonEmptyString },
  relationships: {
    profile: Relationship.one(() => Person),
    posts: Relationship.paginated(() => Article)
  }
})

describe("Resource", () => {
  it("is itself the resource object schema", () => {
    const decoded = Schema.decodeUnknownSync(Article)({
      type: "articles",
      id: "1",
      attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" },
      relationships: {
        author: { data: { type: "people", id: "9" } },
        comments: { data: [{ type: "comments", id: "5" }] }
      }
    })
    expect(decoded.type).toBe("articles")
    expect(decoded.id).toBe("1")
    expect(decoded.attributes.title).toBe("Hello")
    // DateFromString decodes to a Date instance
    expect(decoded.attributes.createdAt).toBeInstanceOf(Date)
    expect(decoded.relationships?.author.data?.id).toBe("9")
  })

  it("rejects a resource with the wrong type tag", () => {
    expect(() =>
      Schema.decodeUnknownSync(Article)({
        type: "people",
        id: "1",
        attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
      })
    ).toThrow()
  })

  it("exposes the resource type name", () => {
    expect(Article.type).toBe("articles")
    expect(Person.type).toBe("people")
    expectTypeOf(Article.type).toEqualTypeOf<"articles">()
  })

  it("brands ids per resource type", () => {
    const articleId = Article.Id.make("1")
    const personId = Person.Id.make("1")
    expect(articleId).toBe("1")
    expect(personId).toBe("1")
    // Branded ids are not assignable across resource types
    expectTypeOf(articleId).not.toEqualTypeOf(personId)
    // Branded ids flow into the resource object type
    expectTypeOf<(typeof Article.Type)["id"]>().toEqualTypeOf<typeof articleId>()
  })

  it("derives the resource identifier schema", () => {
    const decoded = Schema.decodeUnknownSync(Article.identifier)({ type: "articles", id: "1" })
    expect(decoded).toEqual({ type: "articles", id: "1" })
    expect(() => Schema.decodeUnknownSync(Article.identifier)({ type: "people", id: "1" })).toThrow()
  })

  it("encodes decoded resources back to wire form", () => {
    const decoded = Schema.decodeUnknownSync(Article)({
      type: "articles",
      id: "1",
      attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
    })
    const encoded = Schema.encodeUnknownSync(Article)(decoded)
    expect(encoded.attributes.createdAt).toBe("2024-01-01T00:00:00.000Z")
  })

  it("constructs values with make (type tag auto-filled)", () => {
    const article = Article.make({
      id: Article.Id.make("1"),
      attributes: { title: "Hello", body: "World", createdAt: new Date("2024-01-01") },
      relationships: {
        author: { data: { type: "people", id: Person.Id.make("9") } },
        comments: { data: [] }
      }
    })
    expect(article.type).toBe("articles")
  })
})

describe("Resource.createPayload", () => {
  it("accepts a payload without id", () => {
    const decoded = Schema.decodeUnknownSync(Article.createPayload)({
      data: {
        type: "articles",
        attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
      }
    })
    expect(decoded.data.attributes.title).toBe("Hello")
  })

  it("accepts a payload with a client-generated lid", () => {
    const decoded = Schema.decodeUnknownSync(Article.createPayload)({
      data: {
        type: "articles",
        lid: "temp-1",
        attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
      }
    })
    expect(decoded.data.lid).toBe("temp-1")
  })

  it("rejects a payload with a server-assigned id", () => {
    expect(() =>
      Schema.decodeUnknownSync(Article.createPayload)(
        {
          data: {
            type: "articles",
            id: "1",
            attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
          }
        },
        { onExcessProperty: "error" }
      )
    ).toThrow()
  })

  it("does not expose an id key in the payload type", () => {
    type CreateData = (typeof Article.createPayload.Type)["data"]
    expectTypeOf<CreateData>().not.toHaveProperty("id")
    expectTypeOf<CreateData["lid"]>().toEqualTypeOf<string | undefined>()
  })

  it("requires relationships when the resource has a `one` relationship", () => {
    // Comment.author is `one` → the payload must carry it.
    expect(() =>
      Schema.decodeUnknownSync(Comment.createPayload)({
        data: { type: "comments", attributes: { body: "Nice" } }
      })
    ).toThrow()

    const decoded = Schema.decodeUnknownSync(Comment.createPayload)({
      data: {
        type: "comments",
        attributes: { body: "Nice" },
        relationships: { author: { data: { type: "people", id: "9" } } }
      }
    })
    expect(decoded.data.relationships.author.data.id).toBe("9")
  })

  it("rejects null linkage for a `one` relationship in the payload", () => {
    expect(() =>
      Schema.decodeUnknownSync(Comment.createPayload)({
        data: {
          type: "comments",
          attributes: { body: "Nice" },
          relationships: { author: { data: null } }
        }
      })
    ).toThrow()
  })

  it("keeps relationships optional when the resource has no `one` relationship", () => {
    // Article only has `optional` / `many` relationships.
    const decoded = Schema.decodeUnknownSync(Article.createPayload)({
      data: {
        type: "articles",
        attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
      }
    })
    expect(decoded.data.relationships).toBeUndefined()
  })

  it("excludes paginated relationships from the payload", () => {
    // Author.posts is paginated → it cannot be supplied at create time.
    expect(() =>
      Schema.decodeUnknownSync(Author.createPayload)(
        {
          data: {
            type: "authors",
            attributes: { name: "Dan" },
            relationships: {
              profile: { data: { type: "people", id: "9" } },
              posts: { data: [{ type: "articles", id: "1" }] }
            }
          }
        },
        { onExcessProperty: "error" }
      )
    ).toThrow()

    // Without the paginated key the payload decodes (profile is required).
    const decoded = Schema.decodeUnknownSync(Author.createPayload)({
      data: {
        type: "authors",
        attributes: { name: "Dan" },
        relationships: { profile: { data: { type: "people", id: "9" } } }
      }
    })
    expect(decoded.data.relationships.profile.data.id).toBe("9")
    // ... and the paginated key does not exist in the payload type.
    type CreateRels = (typeof Author.createPayload.Type)["data"]["relationships"]
    expectTypeOf<CreateRels>().not.toHaveProperty("posts")
  })
})

describe("Resource.updatePayload", () => {
  it("requires id and accepts partial attributes", () => {
    const decoded = Schema.decodeUnknownSync(Article.updatePayload)({
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Updated" }
      }
    })
    expect(decoded.data.id).toBe("1")
    expect(decoded.data.attributes?.title).toBe("Updated")
  })

  it("rejects a payload without id", () => {
    expect(() =>
      Schema.decodeUnknownSync(Article.updatePayload)({
        data: { type: "articles", attributes: { title: "Updated" } }
      })
    ).toThrow()
  })

  it("keeps all relationships optional (PATCH semantics), even `one`", () => {
    // Omitting a required relationship in a PATCH means "leave it unchanged".
    const decoded = Schema.decodeUnknownSync(Comment.updatePayload)({
      data: { type: "comments", id: "5", attributes: { body: "Updated" } }
    })
    expect(decoded.data.relationships).toBeUndefined()

    // But when present, `one` linkage still can't be null.
    expect(() =>
      Schema.decodeUnknownSync(Comment.updatePayload)({
        data: {
          type: "comments",
          id: "5",
          relationships: { author: { data: null } }
        }
      })
    ).toThrow()
  })

  it("excludes paginated relationships from the payload", () => {
    expect(() =>
      Schema.decodeUnknownSync(Author.updatePayload)(
        {
          data: {
            type: "authors",
            id: "7",
            relationships: { posts: { data: [] } }
          }
        },
        { onExcessProperty: "error" }
      )
    ).toThrow()
    type UpdateRels = NonNullable<(typeof Author.updatePayload.Type)["data"]["relationships"]>
    expectTypeOf<UpdateRels>().not.toHaveProperty("posts")
  })
})

describe("Resource relationships", () => {
  it("optional accepts null data (empty linkage)", () => {
    const decoded = Schema.decodeUnknownSync(Article)({
      type: "articles",
      id: "1",
      attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" },
      relationships: {
        author: { data: null },
        comments: { data: [] }
      }
    })
    expect(decoded.relationships?.author.data).toBeNull()
  })

  it("one rejects null data (required linkage)", () => {
    expect(() =>
      Schema.decodeUnknownSync(Comment)({
        type: "comments",
        id: "5",
        attributes: { body: "Nice" },
        relationships: { author: { data: null } }
      })
    ).toThrow()
  })

  it("many accepts an empty array but not null", () => {
    const decode = (data: unknown) =>
      Schema.decodeUnknownSync(Article)({
        type: "articles",
        id: "1",
        attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" },
        relationships: {
          author: { data: { type: "people", id: "9" } },
          comments: { data }
        }
      })
    expect(decode([]).relationships?.comments.data).toEqual([])
    expect(() => decode(null)).toThrow()
  })

  it("paginated carries only links (no inline data)", () => {
    const decoded = Schema.decodeUnknownSync(Author)({
      type: "authors",
      id: "7",
      attributes: { name: "Dan" },
      relationships: {
        profile: { data: { type: "people", id: "9" } },
        posts: { links: { related: "/authors/7/posts" }, meta: { count: 42 } }
      }
    })
    expect(decoded.relationships?.posts.links.related).toBe("/authors/7/posts")
    expect(decoded.relationships?.posts.meta?.count).toBe(42)
    expectTypeOf(decoded.relationships!.posts).not.toHaveProperty("data")
  })

  it("rejects relationship identifiers of the wrong type", () => {
    expect(() =>
      Schema.decodeUnknownSync(Comment)({
        type: "comments",
        id: "5",
        attributes: { body: "Nice" },
        relationships: { author: { data: { type: "articles", id: "1" } } }
      })
    ).toThrow()
  })

  it("exposes relationship descriptors for graph walking", () => {
    expect(Object.keys(Article.relationships)).toEqual(["author", "comments"])
    expect(Article.relationships.author.kind).toBe("optional")
    expect(Article.relationships.comments.kind).toBe("many")
    expect(Comment.relationships.author.kind).toBe("one")
    expect(Author.relationships.posts.kind).toBe("paginated")
    expect(Article.relationships.author.ref().type).toBe("people")
  })
})

describe("Resource.document / Resource.collection", () => {
  it("document produces non-null primary data", () => {
    const doc = Article.document()
    const withData = Schema.decodeUnknownSync(doc)({
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
      }
    })
    expect(withData.data.id).toBe("1")
    expectTypeOf(withData.data).toEqualTypeOf<typeof Article.Type>()
    // `data` is the resource verbatim now — `null` is rejected
    expect(() => Schema.decodeUnknownSync(doc)({ data: null })).toThrow()
  })

  it("collection requires array data", () => {
    const doc = Article.collection()
    const decoded = Schema.decodeUnknownSync(doc)({ data: [] })
    expect(decoded.data).toEqual([])
    expect(() => Schema.decodeUnknownSync(doc)({ data: null })).toThrow()
  })

  it("included union is derived from the relationship graph (one hop)", () => {
    const doc = Article.document()
    const decoded = Schema.decodeUnknownSync(doc)({
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" },
        relationships: {
          author: { data: { type: "people", id: "9" } },
          comments: { data: [{ type: "comments", id: "5" }] }
        }
      },
      included: [
        { type: "people", id: "9", attributes: { firstName: "John", lastName: "Doe" } },
        { type: "comments", id: "5", attributes: { body: "Nice" } }
      ]
    })
    expect(decoded.included).toHaveLength(2)
  })

  it("included rejects resources outside the relationship graph", () => {
    const doc = Comment.document()
    expect(() =>
      Schema.decodeUnknownSync(doc)({
        data: { type: "comments", id: "5", attributes: { body: "Nice" } },
        included: [
          // articles is not reachable from Comment's relationships
          {
            type: "articles",
            id: "1",
            attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
          }
        ]
      })
    ).toThrow()
  })

  it("paginated relationship targets are excluded from the included union", () => {
    // Author.posts is paginated → Article is NOT an includable target of Author;
    // only Person (via the `one` profile relationship) is.
    const doc = Author.document()
    expect(() =>
      Schema.decodeUnknownSync(doc)({
        data: {
          type: "authors",
          id: "7",
          attributes: { name: "Dan" },
          relationships: {
            profile: { data: { type: "people", id: "9" } },
            posts: { links: { related: "/authors/7/posts" } }
          }
        },
        included: [
          {
            type: "articles",
            id: "1",
            attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
          }
        ]
      })
    ).toThrow()

    // The linkable target (Person) still works.
    const decoded = Schema.decodeUnknownSync(doc)({
      data: {
        type: "authors",
        id: "7",
        attributes: { name: "Dan" },
        relationships: {
          profile: { data: { type: "people", id: "9" } },
          posts: { links: { related: "/authors/7/posts" } }
        }
      },
      included: [{ type: "people", id: "9", attributes: { firstName: "John", lastName: "Doe" } }]
    })
    expect(decoded.included).toHaveLength(1)
  })

  it("included can be overridden explicitly for deeper compound documents", () => {
    const doc = Article.document({ included: Schema.Union([Person, Comment]) })
    const decoded = Schema.decodeUnknownSync(doc)({
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
      },
      included: [{ type: "people", id: "9", attributes: { firstName: "John", lastName: "Doe" } }]
    })
    expect(decoded.included).toHaveLength(1)
  })

  it("typed resource meta flows into documents", () => {
    const decoded = Schema.decodeUnknownSync(Article)({
      type: "articles",
      id: "1",
      attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" },
      meta: { rank: 3 }
    })
    expect(decoded.meta?.rank).toBe(3)
    expectTypeOf<NonNullable<(typeof Article.Type)["meta"]>["rank"]>().toEqualTypeOf<number>()
  })

  it("document meta can be overridden per document", () => {
    const PageMeta = Schema.Struct({ total: Schema.Int })
    const doc = Article.collection({ meta: PageMeta })
    const decoded = Schema.decodeUnknownSync(doc)({ data: [], meta: { total: 0 } })
    expect(decoded.meta?.total).toBe(0)
  })
})

describe("DataDocument nullability is compositional", () => {
  const article = {
    type: "articles",
    id: "1",
    attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
  }

  it("non-null: `data` is the resource verbatim and `null` is rejected", () => {
    const doc = DataDocument(Article)
    const decoded = Schema.decodeUnknownSync(doc)({ data: article })
    expect(decoded.data.id).toBe("1")
    expectTypeOf(decoded.data).toEqualTypeOf<typeof Article.Type>()
    expect(() => Schema.decodeUnknownSync(doc)({ data: null })).toThrow()
  })

  it("NullOr: `data` is `resource | null` and round-trips `null` on the wire", () => {
    const doc = DataDocument(Schema.NullOr(Article))
    const decoded = Schema.decodeUnknownSync(doc)({ data: null })
    expect(decoded.data).toBeNull()
    expectTypeOf(decoded.data).toEqualTypeOf<typeof Article.Type | null>()
    expect(Schema.encodeUnknownSync(doc)({ data: null })).toEqual({ data: null })
  })

  it("OptionFromNullOr: `data` is `Option<resource>`, encoding `None ⇆ null`", () => {
    const doc = DataDocument(Article.nullable())
    const none = Schema.decodeUnknownSync(doc)({ data: null })
    expect(Option.isNone(none.data)).toBe(true)
    const some = Schema.decodeUnknownSync(doc)({ data: article })
    expect(Option.isSome(some.data)).toBe(true)
    expectTypeOf(some.data).toEqualTypeOf<Option.Option<typeof Article.Type>>()
    // `None` encodes back to a spec-conformant `data: null`
    expect(Schema.encodeUnknownSync(doc)({ data: Option.none() })).toEqual({ data: null })
  })

  it("generalises to linkage unions with no special case", () => {
    const doc = DataDocument(Schema.NullOr(Schema.Union([Comment.identifier, Schema.Array(Comment.identifier)])))
    expect(Schema.decodeUnknownSync(doc)({ data: null }).data).toBeNull()
    expect(Schema.decodeUnknownSync(doc)({ data: { type: "comments", id: "5" } }).data).toEqual({
      type: "comments",
      id: "5"
    })
    expect(Schema.decodeUnknownSync(doc)({ data: [{ type: "comments", id: "5" }] }).data).toEqual([
      { type: "comments", id: "5" }
    ])
  })

  it("included derivation still works when `data` is wrapped", () => {
    // `included` keys off the underlying resource graph (Article's non-paginated
    // relationship targets), independent of how the primary `data` is wrapped.
    expect(directTargets(Article).map((target) => target.type)).toEqual(["people", "comments"])
    const doc = DataDocument(Schema.NullOr(Article), {
      included: Schema.Union([Person, Comment])
    })
    const decoded = Schema.decodeUnknownSync(doc)({
      data: null,
      included: [{ type: "people", id: "9", attributes: { firstName: "John", lastName: "Doe" } }]
    })
    expect(decoded.data).toBeNull()
    expect(decoded.included).toHaveLength(1)
    // resources outside the relationship graph are still rejected
    expect(() =>
      Schema.decodeUnknownSync(doc)({
        data: null,
        included: [{ type: "tags", id: "1", attributes: { name: "x" } }]
      })
    ).toThrow()
  })
})

describe("Resource without relationships", () => {
  it("decodes documents without included", () => {
    const doc = Person.document()
    const decoded = Schema.decodeUnknownSync(doc)({
      data: { type: "people", id: "9", attributes: { firstName: "John", lastName: "Doe" } }
    })
    expect(decoded.data.attributes.firstName).toBe("John")
  })
})

describe("Resource.ref", () => {
  it("creates a typed resource-identifier value", () => {
    const ref = Article.ref("1")
    expect(ref).toEqual({ type: "articles", id: "1" })
    // the id is branded with the resource type
    expectTypeOf(ref.id).toEqualTypeOf<typeof Article.Id.Type>()
    expectTypeOf(ref.type).toEqualTypeOf<"articles">()
  })

  it("refs are usable as relationship linkage", () => {
    const article = Article.make({
      id: Article.Id.make("1"),
      attributes: { title: "Hello", body: "World", createdAt: new Date("2024-01-01") },
      relationships: {
        author: { data: Person.ref("9") },
        comments: { data: [Comment.ref("5")] }
      }
    })
    expect(article.relationships?.author.data?.id).toBe("9")
    expect(article.relationships?.comments.data[0]?.type).toBe("comments")
  })

  it("refs validate against the identifier schema", () => {
    const decoded = Schema.decodeUnknownSync(Article.identifier)(Article.ref("1"))
    expect(decoded.id).toBe("1")
  })
})

describe("heterogeneous (union) documents", () => {
  // A polymorphic feed: data items are either articles or people,
  // discriminated by the `type` tag.
  const FeedItem = Schema.Union([Article, Person])

  it("single-resource documents accept a union of resources", () => {
    const doc = DataDocument(FeedItem)
    const asArticle = Schema.decodeUnknownSync(doc)({
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
      }
    })
    expect(asArticle.data.type).toBe("articles")

    const asPerson = Schema.decodeUnknownSync(doc)({
      data: { type: "people", id: "9", attributes: { firstName: "John", lastName: "Doe" } }
    })
    expect(asPerson.data.type).toBe("people")
  })

  it("collection documents accept mixed resource types", () => {
    const feed = CollectionDocument(FeedItem)
    const decoded = Schema.decodeUnknownSync(feed)({
      data: [
        {
          type: "articles",
          id: "1",
          attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
        },
        { type: "people", id: "9", attributes: { firstName: "John", lastName: "Doe" } }
      ]
    })
    expect(decoded.data.map((item) => item.type)).toEqual(["articles", "people"])
    // the union is discriminated by the `type` tag
    const first = decoded.data[0]
    if (first?.type === "articles") {
      expectTypeOf(first.attributes.title).toEqualTypeOf<string>()
    }
  })

  it("rejects resources outside the union", () => {
    const feed = CollectionDocument(FeedItem)
    expect(() =>
      Schema.decodeUnknownSync(feed)({
        data: [{ type: "comments", id: "5", attributes: { body: "Nice" } }]
      })
    ).toThrow()
  })
})

describe("Identifier", () => {
  it("can be used standalone", () => {
    const PersonIdentifier = Identifier("people")
    const decoded = Schema.decodeUnknownSync(PersonIdentifier)({ type: "people", id: "9" })
    expect(decoded.id).toBe("9")
  })
})

describe("forward references", () => {
  it("resolves thunks regardless of declaration order", () => {
    // Tag references Post which is declared *after* it.
    const Tag = Resource("tags", {
      attributes: { name: Schema.String },
      relationships: { posts: Relationship.many((): typeof Post => Post) }
    })
    const Post = Resource("posts", {
      attributes: { title: Schema.String }
    })
    expect(Tag.relationships.posts.ref().type).toBe("posts")
    const doc = Tag.document()
    const decoded = Schema.decodeUnknownSync(doc)({
      data: {
        type: "tags",
        id: "1",
        attributes: { name: "effect" },
        relationships: { posts: { data: [{ type: "posts", id: "2" }] } }
      },
      included: [{ type: "posts", id: "2", attributes: { title: "Hello" } }]
    })
    expect(decoded.included).toHaveLength(1)
  })
})

describe("type-level guarantees", () => {
  it("attribute types flow into the resource Type", () => {
    expectTypeOf<(typeof Article.Type)["attributes"]["title"]>().toEqualTypeOf<string>()
    expectTypeOf<(typeof Article.Type)["attributes"]["createdAt"]>().toEqualTypeOf<Date>()
    // Encoded side keeps the wire form
    expectTypeOf<(typeof Article.Encoded)["attributes"]["createdAt"]>().toEqualTypeOf<string>()
  })

  it("relationship identifier types are tagged with the target resource type", () => {
    type AuthorData = NonNullable<NonNullable<(typeof Article.Type)["relationships"]>["author"]["data"]>
    expectTypeOf<AuthorData["type"]>().toEqualTypeOf<"people">()
  })

  it("default meta is a free-form record", () => {
    expectTypeOf<NonNullable<(typeof Person.Type)["meta"]>>().toEqualTypeOf<{
      readonly [x: string]: unknown
    }>()
  })
})

describe("AnyMeta", () => {
  it("accepts arbitrary records", () => {
    const decoded = Schema.decodeUnknownSync(AnyMeta)({ anything: [1, 2, 3], nested: { a: true } })
    expect(decoded.anything).toEqual([1, 2, 3])
  })
})

describe("Resource.attributes / Resource.relationships", () => {
  it("extracts the attribute field map", () => {
    const fields = attributesOf(Article)
    expect(Object.keys(fields)).toEqual(["title", "body", "createdAt"])
    // the extracted schemas are the ones the resource was defined with
    expect(Schema.decodeUnknownSync(fields.title)("Hello")).toBe("Hello")
  })

  it("attributes can be spread into a new resource definition", () => {
    const Profile = Resource("profiles", {
      attributes: { ...attributesOf(Person), bio: Schema.String }
    })
    const decoded = Schema.decodeUnknownSync(Profile)({
      type: "profiles",
      id: "1",
      attributes: { firstName: "John", lastName: "Doe", bio: "hi" }
    })
    expect(decoded.attributes.firstName).toBe("John")
    expect(decoded.attributes.bio).toBe("hi")
  })

  it("extracts the relationship descriptor record", () => {
    const rels = relationshipsOf(Article)
    expect(Object.keys(rels)).toEqual(["author", "comments"])
    expect(rels.author.kind).toBe("optional")
    expect(rels.comments.ref().type).toBe("comments")
    // it is the same record the resource exposes
    expect(rels).toBe(Article.relationships)
  })
})

describe("Resource.extend", () => {
  // The shared shape, defined once.
  const Account = Resource("accounts", {
    attributes: {
      email: Schema.NonEmptyString,
      createdAt: Schema.DateFromString
    },
    relationships: { profile: Relationship.one(() => Person) },
    meta: Schema.Struct({ tier: Schema.Int })
  })

  const Admin = extend(Account, "admins", {
    attributes: { permissions: Schema.Array(Schema.String) },
    relationships: { manages: Relationship.many(() => Account) }
  })

  it("creates a distinct resource type with its own branded id", () => {
    expect(Admin.type).toBe("admins")
    expectTypeOf(Admin.type).toEqualTypeOf<"admins">()
    const adminId = Admin.Id.make("1")
    const accountId = Account.Id.make("1")
    expectTypeOf(adminId).not.toEqualTypeOf(accountId)
    expect(() => Schema.decodeUnknownSync(Admin.identifier)({ type: "accounts", id: "1" })).toThrow()
  })

  it("inherits the base attributes and relationships, adding its own", () => {
    const decoded = Schema.decodeUnknownSync(Admin)({
      type: "admins",
      id: "1",
      attributes: { email: "a@b.c", createdAt: "2024-01-01T00:00:00.000Z", permissions: ["write"] },
      relationships: {
        profile: { data: { type: "people", id: "9" } },
        manages: { data: [{ type: "accounts", id: "2" }] }
      }
    })
    // inherited attribute, decoded by the inherited schema (string ⇆ Date)
    expect(decoded.attributes.createdAt).toBeInstanceOf(Date)
    // added attribute
    expect(decoded.attributes.permissions).toEqual(["write"])
    // inherited + added relationships
    expect(decoded.relationships?.profile.data.id).toBe("9")
    expect(decoded.relationships?.manages.data[0]?.type).toBe("accounts")
    // type-level: the attribute map is the merge of base and extra
    expectTypeOf<(typeof Admin.Type)["attributes"]>().toEqualTypeOf<{
      readonly email: string
      readonly createdAt: Date
      readonly permissions: ReadonlyArray<string>
    }>()
  })

  it("derives payloads afresh for the new type, carrying inherited `one` relationships", () => {
    // Account.profile is `one` → inherited as required in the create payload.
    expect(() =>
      Schema.decodeUnknownSync(Admin.createPayload)({
        data: { type: "admins", attributes: { email: "a@b.c", createdAt: "2024-01-01T00:00:00.000Z", permissions: [] } }
      })
    ).toThrow()

    const decoded = Schema.decodeUnknownSync(Admin.createPayload)({
      data: {
        type: "admins",
        attributes: { email: "a@b.c", createdAt: "2024-01-01T00:00:00.000Z", permissions: [] },
        relationships: { profile: { data: { type: "people", id: "9" } } }
      }
    })
    expect(decoded.data.relationships.profile.data.id).toBe("9")
  })

  it("inherits the base meta by default", () => {
    const decoded = Schema.decodeUnknownSync(Admin)({
      type: "admins",
      id: "1",
      attributes: { email: "a@b.c", createdAt: "2024-01-01T00:00:00.000Z", permissions: [] },
      meta: { tier: 3 }
    })
    expect(decoded.meta?.tier).toBe(3)
    expectTypeOf<NonNullable<(typeof Admin.Type)["meta"]>["tier"]>().toEqualTypeOf<number>()
  })

  it("can override the meta", () => {
    const Flagged = extend(Account, "flagged", { meta: Schema.Struct({ flag: Schema.Boolean }) })
    const decoded = Schema.decodeUnknownSync(Flagged)({
      type: "flagged",
      id: "1",
      attributes: { email: "a@b.c", createdAt: "2024-01-01T00:00:00.000Z" },
      meta: { flag: true }
    })
    expect(decoded.meta?.flag).toBe(true)
  })

  it("lets extra fields override the base on key collision", () => {
    const Restricted = extend(Account, "restricted", {
      attributes: { email: Schema.Literal("fixed@example.com") }
    })
    const decoded = Schema.decodeUnknownSync(Restricted)({
      type: "restricted",
      id: "1",
      attributes: { email: "fixed@example.com", createdAt: "2024-01-01T00:00:00.000Z" }
    })
    expect(decoded.attributes.email).toBe("fixed@example.com")
    expect(() =>
      Schema.decodeUnknownSync(Restricted)({
        type: "restricted",
        id: "1",
        attributes: { email: "anything@example.com", createdAt: "2024-01-01T00:00:00.000Z" }
      })
    ).toThrow()
  })

  it("extends with attributes only (relationships optional)", () => {
    const Named = extend(Person, "named", { attributes: { nickname: Schema.String } })
    const decoded = Schema.decodeUnknownSync(Named)({
      type: "named",
      id: "1",
      attributes: { firstName: "John", lastName: "Doe", nickname: "JD" }
    })
    expect(decoded.attributes.nickname).toBe("JD")
    expect(Object.keys(Named.relationships)).toEqual([])
  })

  it("derives the included union from the merged relationship graph", () => {
    // Admin's linkable targets: Person (inherited `profile`) and Account (added `manages`).
    expect(directTargets(Admin).map((target) => target.type)).toEqual(["people", "accounts"])
    const doc = Admin.document()
    const decoded = Schema.decodeUnknownSync(doc)({
      data: {
        type: "admins",
        id: "1",
        attributes: { email: "a@b.c", createdAt: "2024-01-01T00:00:00.000Z", permissions: [] },
        relationships: {
          profile: { data: { type: "people", id: "9" } },
          manages: { data: [{ type: "accounts", id: "2" }] }
        }
      },
      included: [
        { type: "people", id: "9", attributes: { firstName: "John", lastName: "Doe" } },
        {
          type: "accounts",
          id: "2",
          attributes: { email: "x@y.z", createdAt: "2024-01-01T00:00:00.000Z" }
        }
      ]
    })
    expect(decoded.included).toHaveLength(2)
  })

  it("leaves the base resource unchanged", () => {
    expect(Object.keys(attributesOf(Account))).toEqual(["email", "createdAt"])
    expect(Object.keys(Account.relationships)).toEqual(["profile"])
  })
})

// ---------------------------------------------------------------------------
// Custom id-schema injection
// ---------------------------------------------------------------------------

describe("Resource custom id injection", () => {
  // The consumer's own externally-defined branded id schema — here a single
  // brand, but it could be a hierarchical multi-brand or any codec to `string`.
  const PersonId = Schema.String.pipe(Schema.brand("PersonId"))
  const Person = Resource("people", {
    id: PersonId,
    attributes: { name: Schema.NonEmptyString }
  })

  it("uses the injected id schema as the resource's Id", () => {
    expectTypeOf<typeof Person.Id>().toEqualTypeOf<typeof PersonId>()
    const decoded = Schema.decodeUnknownSync(Person)({
      type: "people",
      id: "9",
      attributes: { name: "Dan" }
    })
    expect(decoded.id).toBe("9")
    // the resource object's id carries the injected brand
    expectTypeOf<(typeof Person.Type)["id"]>().toEqualTypeOf<typeof PersonId.Type>()
  })

  it("threads the injected id through the identifier", () => {
    expectTypeOf<(typeof Person.identifier.Type)["id"]>().toEqualTypeOf<typeof PersonId.Type>()
    const decoded = Schema.decodeUnknownSync(Person.identifier)({ type: "people", id: "9" })
    expect(decoded).toEqual({ type: "people", id: "9" })
  })

  it("threads the injected id through the update payload and documents", () => {
    expectTypeOf<(typeof Person.updatePayload.Type)["data"]["id"]>().toEqualTypeOf<typeof PersonId.Type>()
    const doc = DataDocument(Person)
    expectTypeOf<(typeof doc.Type)["data"]["id"]>().toEqualTypeOf<typeof PersonId.Type>()
  })

  it("ref produces a value carrying the injected brand", () => {
    const ref = Person.ref("9")
    expect(ref).toEqual({ type: "people", id: "9" })
    expectTypeOf<typeof ref.id>().toEqualTypeOf<typeof PersonId.Type>()
  })

  it("Identifier accepts a custom id schema standalone", () => {
    const PersonIdentifier = Identifier("people", PersonId)
    const decoded = Schema.decodeUnknownSync(PersonIdentifier)({ type: "people", id: "9" })
    expect(decoded.id).toBe("9")
    expectTypeOf<(typeof PersonIdentifier.Type)["id"]>().toEqualTypeOf<typeof PersonId.Type>()
  })

  it("defaults to the auto branded id when none is injected (no breaking change)", () => {
    const Tag = Resource("tags", { attributes: { name: Schema.String } })
    const tagId = Tag.Id.make("1")
    expect(tagId).toBe("1")
    // the default brand is still the per-type one
    expectTypeOf<(typeof Tag.Type)["id"]>().toEqualTypeOf<typeof tagId>()
  })

  it("can be extended (the new type gets its own default id)", () => {
    const Member = extend(Person, "members", { attributes: { role: Schema.String } })
    const decoded = Schema.decodeUnknownSync(Member)({
      type: "members",
      id: "1",
      attributes: { name: "Dan", role: "admin" }
    })
    expect(decoded.attributes.role).toBe("admin")
  })

  it("create payload still carries no id member (server-assigned), custom id or not", () => {
    const decoded = Schema.decodeUnknownSync(Person.createPayload)({
      data: { type: "people", attributes: { name: "Dan" } }
    })
    expect("id" in decoded.data).toBe(false)
    type CreateData = (typeof Person.createPayload.Type)["data"]
    expectTypeOf<CreateData>().not.toHaveProperty("id")
  })

  it("collection data carries the injected id brand", () => {
    const doc = Person.collection()
    expectTypeOf<(typeof doc.Type)["data"][number]["id"]>().toEqualTypeOf<typeof PersonId.Type>()
  })
})

// ---------------------------------------------------------------------------
// Variant-aware attributes: tri-state update + per-attribute annotations
// ---------------------------------------------------------------------------

describe("Resource attribute annotations", () => {
  const Widget = Resource("widgets", {
    attributes: {
      name: Schema.NonEmptyString.annotate({ dbColumn: "widget_name" }),
      note: Schema.NullOr(Schema.String).annotate({ dbColumn: "note_text" }),
      plain: Schema.String
    }
  })

  it("reads per-attribute annotations off the resource", () => {
    const annotations = attributeAnnotations(Widget)
    expect(annotations.name?.dbColumn).toBe("widget_name")
    expect(annotations.note?.dbColumn).toBe("note_text")
    // an attribute with no annotations has no dbColumn
    expect(annotations.plain?.dbColumn).toBeUndefined()
  })

  it("exposes a key for every attribute", () => {
    expect(Object.keys(attributeAnnotations(Widget))).toEqual(["name", "note", "plain"])
  })
})

describe("Resource.updatePayload tri-state semantics", () => {
  const Widget = Resource("widgets", {
    attributes: {
      name: Schema.NonEmptyString,
      note: Schema.NullOr(Schema.String)
    }
  })
  const decode = (attributes: unknown) =>
    Schema.decodeUnknownSync(Widget.updatePayload)({ data: { type: "widgets", id: "1", attributes } })

  it("set: a present value updates the attribute", () => {
    const decoded = decode({ note: "hello" })
    expect(decoded.data.attributes?.note).toBe("hello")
  })

  it("unset (null): a nullable attribute accepts null to clear it", () => {
    const decoded = decode({ note: null })
    expect(decoded.data.attributes?.note).toBeNull()
  })

  it("unset (undefined): a present `undefined` is accepted", () => {
    const decoded = decode({ note: undefined })
    expect(decoded.data.attributes && "note" in decoded.data.attributes).toBe(true)
    expect(decoded.data.attributes?.note).toBeUndefined()
  })

  it("leave unchanged: an absent key is accepted and stays absent", () => {
    const decoded = decode({})
    expect(decoded.data.attributes && "note" in decoded.data.attributes).toBe(false)
  })

  it("over a JSON wire: null clears a nullable attribute, absent leaves it unchanged", () => {
    // A real HTTP body is JSON (no `undefined`): null is the wire clear signal.
    const cleared = Schema.decodeUnknownSync(Widget.updatePayload)(
      JSON.parse('{"data":{"type":"widgets","id":"1","attributes":{"note":null}}}')
    )
    expect(cleared.data.attributes?.note).toBeNull()
    const unchanged = Schema.decodeUnknownSync(Widget.updatePayload)(
      JSON.parse('{"data":{"type":"widgets","id":"1","attributes":{}}}')
    )
    expect(unchanged.data.attributes && "note" in unchanged.data.attributes).toBe(false)
  })

  it("a non-nullable attribute accepts undefined (in-process unset) but rejects null", () => {
    const accepted = decode({ name: undefined })
    expect(accepted.data.attributes && "name" in accepted.data.attributes).toBe(true)
    expect(() => decode({ name: null })).toThrow()
  })

  it("types a nullable attribute as value | null | undefined", () => {
    type Attrs = NonNullable<(typeof Widget.updatePayload.Type)["data"]["attributes"]>
    expectTypeOf<Attrs["note"]>().toEqualTypeOf<string | null | undefined>()
    expectTypeOf<Attrs["name"]>().toEqualTypeOf<string | undefined>()
  })
})

// ---------------------------------------------------------------------------
// Flat ("command-style") payload projections
// ---------------------------------------------------------------------------

describe("Resource flat inputs", () => {
  const PersonId = Schema.String.pipe(Schema.brand("PersonId"))
  const Person = Resource("people", {
    id: PersonId,
    attributes: {
      name: Schema.NonEmptyString,
      bio: Schema.NullOr(Schema.String)
    }
  })

  it("createInput is a flat attributes struct (no JSON:API envelope)", () => {
    const decoded = Schema.decodeUnknownSync(Person.createInput)({ name: "Dan", bio: null })
    expect(decoded).toEqual({ name: "Dan", bio: null })
    expectTypeOf<typeof Person.createInput.Type>().toEqualTypeOf<{
      readonly name: string
      readonly bio: string | null
    }>()
  })

  it("updateInput is flat: id plus tri-state attributes", () => {
    const decoded = Schema.decodeUnknownSync(Person.updateInput)({ id: "1", bio: null })
    expect(decoded.id).toBe("1")
    expect(decoded.bio).toBeNull()
    // omitting an attribute leaves it unchanged
    const minimal = Schema.decodeUnknownSync(Person.updateInput)({ id: "1" })
    expect("name" in minimal).toBe(false)
    // the id carries the injected brand; nullable attribute is value | null | undefined
    expectTypeOf<(typeof Person.updateInput.Type)["id"]>().toEqualTypeOf<typeof PersonId.Type>()
    expectTypeOf<(typeof Person.updateInput.Type)["bio"]>().toEqualTypeOf<string | null | undefined>()
  })
})

// ---------------------------------------------------------------------------
// extend with inheritId: encode the subtype relationship in the branded id
// ---------------------------------------------------------------------------

describe("Resource.extend inheritId (subtype ids)", () => {
  const Account = Resource("accounts", { attributes: { email: Schema.NonEmptyString } })

  it("default extend keeps an independent brand — child id is NOT a base id", () => {
    const Admin = extend(Account, "admins", { attributes: { level: Schema.Int } })
    const adminId = Admin.Id.make("1")
    // @ts-expect-error a default-extended admin id is not assignable to an account id
    const asAccount: typeof Account.Id.Type = adminId
    expect(asAccount).toBe("1")
  })

  it("inheritId makes the child id a subtype of the base id (assignable, not vice-versa)", () => {
    const Manager = extend(Account, "managers", { inheritId: true })
    const managerId = Manager.Id.make("1")
    // a manager id IS an account id — this assignment compiles
    const asAccount: typeof Account.Id.Type = managerId
    expect(asAccount).toBe("1")
    // ...but an account id is NOT a manager id
    // @ts-expect-error an account id lacks the managers brand
    const asManager: typeof Manager.Id.Type = Account.Id.make("2")
    expect(asManager).toBe("2")
  })

  it("inheritId is transitive through an extend chain", () => {
    const Manager = extend(Account, "managers", { inheritId: true })
    const Director = extend(Manager, "directors", { inheritId: true, attributes: { region: Schema.String } })
    const directorId = Director.Id.make("1")
    const asManager: typeof Manager.Id.Type = directorId // director ⊂ manager
    const asAccount: typeof Account.Id.Type = directorId // director ⊂ account
    expect(asManager).toBe("1")
    expect(asAccount).toBe("1")
  })

  it("inheritId composes with a custom base id", () => {
    const NodeId = Schema.String.pipe(Schema.brand("NodeId"))
    const Node = Resource("nodes", { id: NodeId, attributes: { name: Schema.String } })
    const Person = extend(Node, "people", { inheritId: true })
    const personId = Person.Id.make("1")
    const asNode: typeof NodeId.Type = personId // a person id IS a node id
    expect(asNode).toBe("1")
  })
})

// ---------------------------------------------------------------------------
// Read-only (server-set) attributes
// ---------------------------------------------------------------------------

describe("Resource.readOnlyAttribute", () => {
  // `createdAt`/`updatedAt` are server-set: present on the resource and in
  // documents, but never accepted as create/update input.
  const Post = Resource("posts", {
    attributes: {
      title: Schema.NonEmptyString,
      createdAt: readOnlyAttribute(Schema.Date),
      // annotate the inner schema first, then wrap (readOnlyAttribute outermost)
      updatedAt: readOnlyAttribute(Schema.NullOr(Schema.Date).annotate({ dbColumn: "updated_at" }))
    },
    relationships: { author: Relationship.one(() => Person) }
  })

  it("keeps read-only attributes in the resource object schema", () => {
    const decoded = Schema.decodeUnknownSync(Post)({
      type: "posts",
      id: "1",
      attributes: { title: "Hello", createdAt: new Date("2024-01-01"), updatedAt: null },
      relationships: { author: { data: { type: "people", id: "9" } } }
    })
    expect(decoded.attributes.title).toBe("Hello")
    expect(decoded.attributes.createdAt).toBeInstanceOf(Date)
    expect(decoded.attributes.updatedAt).toBeNull()
    expectTypeOf<(typeof Post.Type)["attributes"]["title"]>().toEqualTypeOf<string>()
    expectTypeOf<(typeof Post.Type)["attributes"]["createdAt"]>().toEqualTypeOf<Date>()
    expectTypeOf<(typeof Post.Type)["attributes"]["updatedAt"]>().toEqualTypeOf<Date | null>()
  })

  it("surfaces read-only attributes in attributeKeys and attributeAnnotations", () => {
    expect(attributeKeys(Post)).toEqual(["title", "createdAt", "updatedAt"])
    // the underlying schema's annotations still flow through
    expect(attributeAnnotations(Post).updatedAt?.dbColumn).toBe("updated_at")
  })

  it("includes read-only attributes in the resource's documents", () => {
    const Doc = DataDocument(Post)
    type DocAttrs = (typeof Doc.Type)["data"]["attributes"]
    expectTypeOf<DocAttrs["createdAt"]>().toEqualTypeOf<Date>()
    expectTypeOf<DocAttrs["updatedAt"]>().toEqualTypeOf<Date | null>()
    const decoded = Schema.decodeUnknownSync(Doc)({
      data: {
        type: "posts",
        id: "1",
        attributes: { title: "Hello", createdAt: new Date("2024-01-01"), updatedAt: null },
        relationships: { author: { data: { type: "people", id: "9" } } }
      }
    })
    expect(decoded.data.attributes.createdAt).toBeInstanceOf(Date)
  })

  it("excludes read-only attributes from the create payload", () => {
    type CreateAttrs = (typeof Post.createPayload.Type)["data"]["attributes"]
    expectTypeOf<CreateAttrs>().toHaveProperty("title")
    expectTypeOf<CreateAttrs>().not.toHaveProperty("createdAt")
    expectTypeOf<CreateAttrs>().not.toHaveProperty("updatedAt")
    // a create body that omits the server-set attributes decodes cleanly
    const decoded = Schema.decodeUnknownSync(Post.createPayload)({
      data: {
        type: "posts",
        attributes: { title: "Hello" },
        relationships: { author: { data: { type: "people", id: "9" } } }
      }
    })
    expect(decoded.data.attributes).toEqual({ title: "Hello" })
    // a stray read-only attribute on the wire is dropped, not surfaced
    const stray = Schema.decodeUnknownSync(Post.createPayload)({
      data: {
        type: "posts",
        attributes: { title: "Hello", createdAt: new Date("2024-01-01") },
        relationships: { author: { data: { type: "people", id: "9" } } }
      }
    })
    expect(stray.data.attributes).toEqual({ title: "Hello" })
  })

  it("excludes read-only attributes from the update payload", () => {
    type UpdateAttrs = NonNullable<(typeof Post.updatePayload.Type)["data"]["attributes"]>
    expectTypeOf<UpdateAttrs>().toHaveProperty("title")
    expectTypeOf<UpdateAttrs>().not.toHaveProperty("createdAt")
    expectTypeOf<UpdateAttrs>().not.toHaveProperty("updatedAt")
    const decoded = Schema.decodeUnknownSync(Post.updatePayload)({
      data: { type: "posts", id: "1", attributes: { title: "Renamed" } }
    })
    expect(decoded.data.attributes).toEqual({ title: "Renamed" })
  })

  it("excludes read-only attributes from the flat create and update inputs", () => {
    type CreateIn = typeof Post.createInput.Type
    expectTypeOf<CreateIn>().toHaveProperty("title")
    expectTypeOf<CreateIn>().not.toHaveProperty("createdAt")
    expectTypeOf<CreateIn>().not.toHaveProperty("updatedAt")

    type UpdateIn = typeof Post.updateInput.Type
    expectTypeOf<UpdateIn>().toHaveProperty("id")
    expectTypeOf<UpdateIn>().toHaveProperty("title")
    expectTypeOf<UpdateIn>().not.toHaveProperty("createdAt")
    expectTypeOf<UpdateIn>().not.toHaveProperty("updatedAt")

    const createIn = Schema.decodeUnknownSync(Post.createInput)({ title: "Hello" })
    expect(createIn).toEqual({ title: "Hello" })
    const updateIn = Schema.decodeUnknownSync(Post.updateInput)({ id: "1", title: "Renamed" })
    expect(updateIn).toEqual({ id: "1", title: "Renamed" })
  })

  it("leaves a plain attribute read-write (opt-in, non-breaking)", () => {
    const Plain = Resource("plains", { attributes: { name: Schema.NonEmptyString } })
    type CreateAttrs = (typeof Plain.createPayload.Type)["data"]["attributes"]
    expectTypeOf<CreateAttrs>().toHaveProperty("name")
    expectTypeOf<typeof Plain.createInput.Type>().toEqualTypeOf<{ readonly name: string }>()
  })

  it("carries read-only attributes through Resource.extend", () => {
    const Article = extend(Post, "articles", { attributes: { body: Schema.String } })
    // resource projection: read-only attribute is inherited and present
    expect(attributeKeys(Article)).toEqual(["title", "createdAt", "updatedAt", "body"])
    expectTypeOf<(typeof Article.Type)["attributes"]["createdAt"]>().toEqualTypeOf<Date>()
    // write projections: still excluded after extend
    type CreateAttrs = (typeof Article.createPayload.Type)["data"]["attributes"]
    expectTypeOf<CreateAttrs>().toHaveProperty("title")
    expectTypeOf<CreateAttrs>().toHaveProperty("body")
    expectTypeOf<CreateAttrs>().not.toHaveProperty("createdAt")
    expectTypeOf<CreateAttrs>().not.toHaveProperty("updatedAt")
    const decoded = Schema.decodeUnknownSync(Article.createPayload)({
      data: {
        type: "articles",
        attributes: { title: "Hello", body: "World" },
        relationships: { author: { data: { type: "people", id: "9" } } }
      }
    })
    expect(decoded.data.attributes).toEqual({ title: "Hello", body: "World" })
  })
})
