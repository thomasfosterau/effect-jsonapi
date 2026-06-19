import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema } from "effect"
import { AnyMeta, CollectionDocument, DataDocument } from "./Document.js"
import * as Relationship from "./Relationship.js"
import { Identifier, make as Resource } from "./Resource.js"

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
  it("document accepts a single resource or null data", () => {
    const doc = Article.document()
    const withData = Schema.decodeUnknownSync(doc)({
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
      }
    })
    expect(withData.data?.id).toBe("1")
    const withNull = Schema.decodeUnknownSync(doc)({ data: null })
    expect(withNull.data).toBeNull()
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
      data: null,
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

describe("Resource without relationships", () => {
  it("decodes documents without included", () => {
    const doc = Person.document()
    const decoded = Schema.decodeUnknownSync(doc)({
      data: { type: "people", id: "9", attributes: { firstName: "John", lastName: "Doe" } }
    })
    expect(decoded.data?.attributes.firstName).toBe("John")
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
    expect(asArticle.data?.type).toBe("articles")

    const asPerson = Schema.decodeUnknownSync(doc)({
      data: { type: "people", id: "9", attributes: { firstName: "John", lastName: "Doe" } }
    })
    expect(asPerson.data?.type).toBe("people")
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
