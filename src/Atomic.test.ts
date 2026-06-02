import { describe, expect, expectTypeOf, it } from "vitest"
import { Match, Schema } from "effect"
import * as Atomic from "./Atomic.js"
import * as Middleware from "./Middleware.js"
import { Ref, Resource, toMany, toOne } from "./Resource.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const Person = Resource("people", {
  attributes: {
    firstName: Schema.NonEmptyString,
    lastName: Schema.NonEmptyString
  }
})

const Comment = Resource("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: { author: toOne(() => Person) }
})

const Article = Resource("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    body: Schema.String
  },
  relationships: {
    author: toOne(() => Person),
    comments: toMany(() => Comment)
  }
})

const Operations = Atomic.Operations([Article, Comment])
const Request = Atomic.RequestDocument([Article, Comment])
const Results = Atomic.ResultDocument([Article, Comment])

const decodeOperation = Schema.decodeUnknownSync(Operations as Schema.Codec<unknown, unknown>)
const decodeRequest = Schema.decodeUnknownSync(Request as Schema.Codec<unknown, unknown>)
const encodeRequest = Schema.encodeUnknownSync(Request as Schema.Codec<unknown, unknown>)
const decodeResults = Schema.decodeUnknownSync(Results as Schema.Codec<unknown, unknown>)
const encodeResults = Schema.encodeUnknownSync(Results as Schema.Codec<unknown, unknown>)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("extension constants", () => {
  it("exposes the extension URI and media type", () => {
    expect(Atomic.EXTENSION_URI).toBe("https://jsonapi.org/ext/atomic")
    expect(Atomic.MEDIA_TYPE).toBe("application/vnd.api+json;ext=\"https://jsonapi.org/ext/atomic\"")
  })

  it("provides a ready-made jsonapi member advertising the extension", () => {
    expect(Atomic.jsonapi).toEqual({ version: "1.1", ext: ["https://jsonapi.org/ext/atomic"] })
  })
})

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

describe("refs", () => {
  it("Ref decodes id-based identifiers", () => {
    const ref = Schema.decodeUnknownSync(Ref(Article) as Schema.Codec<unknown, unknown>)({
      type: "articles",
      id: "1"
    })
    expect(ref).toEqual({ type: "articles", id: "1" })
  })

  it("Ref decodes lid-based local identifiers", () => {
    const ref = Schema.decodeUnknownSync(Ref(Article) as Schema.Codec<unknown, unknown>)({
      type: "articles",
      lid: "a1"
    })
    expect(ref).toEqual({ type: "articles", lid: "a1" })
  })

  it("Ref rejects identifiers of other types", () => {
    expect(() =>
      Schema.decodeUnknownSync(Ref(Article) as Schema.Codec<unknown, unknown>)({
        type: "people",
        id: "9"
      })
    ).toThrow()
  })

  it("Resource.lidRef creates typed lid-based ref values", () => {
    const ref = Article.lidRef("a1")
    expect(ref).toEqual({ type: "articles", lid: "a1" })
    expectTypeOf(ref.type).toEqualTypeOf<"articles">()
  })

  it("Resource.localIdentifier is the { type, lid } schema", () => {
    const decoded = Schema.decodeUnknownSync(Article.localIdentifier)({ type: "articles", lid: "a1" })
    expect(decoded).toEqual({ type: "articles", lid: "a1" })
    expect(() => Schema.decodeUnknownSync(Article.localIdentifier)({ type: "articles", id: "1" })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Operation schemas: decoding the wire format
// ---------------------------------------------------------------------------

describe("operation schemas", () => {
  it("decodes an add operation", () => {
    const operation = decodeOperation({
      op: "add",
      data: {
        type: "articles",
        lid: "a1",
        attributes: { title: "Hello", body: "World" }
      }
    }) as { op: string; data: { type: string; lid?: string } }
    expect(operation.op).toBe("add")
    expect(operation.data.type).toBe("articles")
    expect(operation.data.lid).toBe("a1")
  })

  it("decodes an add operation with lid-based relationship linkage", () => {
    const operation = decodeOperation({
      op: "add",
      data: {
        type: "articles",
        attributes: { title: "Hello", body: "World" },
        relationships: {
          author: { data: { type: "people", id: "9" } },
          comments: { data: [{ type: "comments", lid: "c1" }] }
        }
      }
    }) as any
    expect(operation.data.relationships.comments.data).toEqual([{ type: "comments", lid: "c1" }])
  })

  it("decodes an update operation targeted by data id", () => {
    const operation = decodeOperation({
      op: "update",
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Updated" }
      }
    }) as any
    expect(operation.op).toBe("update")
    expect(operation.data.id).toBe("1")
    expect(operation.data.attributes).toEqual({ title: "Updated" })
  })

  it("decodes a remove operation targeted by ref", () => {
    const operation = decodeOperation({
      op: "remove",
      ref: { type: "articles", id: "1" }
    }) as any
    expect(operation.op).toBe("remove")
    expect(operation.ref).toEqual({ type: "articles", id: "1" })
  })

  it("decodes a remove operation targeted by lid", () => {
    const operation = decodeOperation({
      op: "remove",
      ref: { type: "articles", lid: "a1" }
    }) as any
    expect(operation.ref).toEqual({ type: "articles", lid: "a1" })
  })

  it("rejects operations on resources outside the set", () => {
    expect(() =>
      decodeOperation({
        op: "add",
        data: { type: "people", attributes: { firstName: "Dan", lastName: "Gebhardt" } }
      })
    ).toThrow()
  })

  it("rejects unknown ops", () => {
    expect(() =>
      decodeOperation({
        op: "upsert",
        data: { type: "articles", attributes: { title: "Hello", body: "" } }
      })
    ).toThrow()
  })
})

describe("relationship operation schemas", () => {
  it("decodes a to-one relationship update", () => {
    const operation = decodeOperation({
      op: "update",
      ref: { type: "comments", id: "5", relationship: "author" },
      data: { type: "people", id: "9" }
    }) as any
    expect(operation.ref.relationship).toBe("author")
    expect(operation.data).toEqual({ type: "people", id: "9" })
  })

  it("decodes a to-one relationship update to null", () => {
    const operation = decodeOperation({
      op: "update",
      ref: { type: "comments", id: "5", relationship: "author" },
      data: null
    }) as any
    expect(operation.data).toBeNull()
  })

  it("decodes to-many relationship add / update / remove", () => {
    for (const op of ["add", "update", "remove"]) {
      const operation = decodeOperation({
        op,
        ref: { type: "articles", id: "1", relationship: "comments" },
        data: [{ type: "comments", id: "5" }, { type: "comments", lid: "c1" }]
      }) as any
      expect(operation.op).toBe(op)
      expect(operation.ref.relationship).toBe("comments")
      expect(operation.data).toHaveLength(2)
    }
  })

  it("rejects relationship refs with unknown relationship names", () => {
    expect(() =>
      decodeOperation({
        op: "update",
        ref: { type: "articles", id: "1", relationship: "publisher" },
        data: null
      })
    ).toThrow()
  })

  it("rejects to-one updates whose data is the wrong resource type", () => {
    expect(() =>
      decodeOperation({
        op: "update",
        ref: { type: "comments", id: "5", relationship: "author" },
        data: { type: "comments", id: "1" }
      })
    ).toThrow()
  })
})

describe("operation union disambiguation", () => {
  it("a ref with a relationship member never decodes as a resource operation", () => {
    // A to-many relationship remove without `data` is invalid — it must NOT
    // fall back to "remove the referenced resource".
    expect(() =>
      decodeOperation({
        op: "remove",
        ref: { type: "articles", id: "1", relationship: "comments" }
      })
    ).toThrow()
  })

  it("a relationship update between same-typed resources stays a relationship update", () => {
    // Comment's author is a Person; an update with ref.relationship must keep
    // the ref (resource updates would drop it).
    const operation = decodeOperation({
      op: "update",
      ref: { type: "comments", id: "5", relationship: "author" },
      data: { type: "people", id: "9" }
    }) as any
    expect(operation.ref.relationship).toBe("author")
  })

  it("resource removes still decode (refs without relationship)", () => {
    const operation = decodeOperation({
      op: "remove",
      ref: { type: "comments", id: "5" }
    }) as any
    expect(operation.ref).toEqual({ type: "comments", id: "5" })
  })
})

// ---------------------------------------------------------------------------
// Request / result documents
// ---------------------------------------------------------------------------

describe("RequestDocument", () => {
  it("decodes a multi-operation document", () => {
    const document = decodeRequest({
      "atomic:operations": [
        { op: "add", data: { type: "articles", lid: "a1", attributes: { title: "Hello", body: "" } } },
        { op: "remove", ref: { type: "comments", id: "5" } }
      ]
    }) as any
    expect(document["atomic:operations"]).toHaveLength(2)
  })

  it("rejects empty operation lists", () => {
    expect(() => decodeRequest({ "atomic:operations": [] })).toThrow()
  })

  it("rejects documents without atomic:operations", () => {
    expect(() => decodeRequest({ data: { type: "articles", id: "1" } })).toThrow()
  })

  it("round-trips operation values built by the constructors", () => {
    const value = Atomic.request(
      Atomic.add(Article, {
        lid: "a1",
        attributes: { title: "Hello", body: "World" },
        relationships: {
          author: { data: Person.ref("9") },
          comments: { data: [Comment.lidRef("c1")] }
        }
      }),
      Atomic.update(Article, { id: Article.Id.make("1"), attributes: { title: "Updated" } }),
      Atomic.remove(Comment, "5"),
      Atomic.updateRelationship(Comment, "5", "author", Person.ref("9")),
      Atomic.addToRelationship(Article, { lid: "a1" }, "comments", [Comment.ref("5")]),
      Atomic.removeFromRelationship(Article, "1", "comments", [Comment.ref("5")])
    )

    const encoded = encodeRequest(value) as any
    expect(encoded["atomic:operations"]).toHaveLength(6)
    expect(encoded["atomic:operations"][0]).toEqual({
      op: "add",
      data: {
        type: "articles",
        lid: "a1",
        attributes: { title: "Hello", body: "World" },
        relationships: {
          author: { data: { type: "people", id: "9" } },
          comments: { data: [{ type: "comments", lid: "c1" }] }
        }
      }
    })
    expect(encoded["atomic:operations"][3]).toEqual({
      op: "update",
      ref: { type: "comments", id: "5", relationship: "author" },
      data: { type: "people", id: "9" }
    })
    expect(encoded["atomic:operations"][4]).toEqual({
      op: "add",
      ref: { type: "articles", lid: "a1", relationship: "comments" },
      data: [{ type: "comments", id: "5" }]
    })

    // and the wire form decodes back
    const decoded = decodeRequest(encoded) as any
    expect(decoded["atomic:operations"]).toHaveLength(6)
  })
})

describe("ResultDocument", () => {
  const article = {
    type: "articles",
    id: "1",
    attributes: { title: "Hello", body: "World" }
  }

  it("decodes results with data, null data and empty objects", () => {
    const document = decodeResults({
      "atomic:results": [{ data: article }, { data: null }, {}]
    }) as any
    expect(document["atomic:results"]).toHaveLength(3)
    expect(document["atomic:results"][0].data.attributes.title).toBe("Hello")
    expect(document["atomic:results"][1].data).toBeNull()
    expect(document["atomic:results"][2]).toEqual({})
  })

  it("encodes values built with the results helpers", () => {
    const value = Atomic.results([
      Atomic.result(article),
      Atomic.emptyResult
    ], { meta: { processed: 2 } })

    const encoded = encodeResults(value) as any
    expect(encoded["atomic:results"]).toHaveLength(2)
    expect(encoded.meta).toEqual({ processed: 2 })
  })

  it("rejects results outside the resource set", () => {
    expect(() =>
      decodeResults({
        "atomic:results": [{ data: { type: "people", id: "9", attributes: { firstName: "D", lastName: "G" } } }]
      })
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Handler helpers
// ---------------------------------------------------------------------------

describe("isRelationshipOperation", () => {
  type Op = Atomic.Operation<typeof Article | typeof Comment>["Type"]

  it("discriminates relationship operations from resource operations", () => {
    const relationshipOp = decodeOperation({
      op: "update",
      ref: { type: "comments", id: "5", relationship: "author" },
      data: { type: "people", id: "9" }
    }) as Op
    const resourceOp = decodeOperation({
      op: "remove",
      ref: { type: "comments", id: "5" }
    }) as Op

    expect(Atomic.isRelationshipOperation(relationshipOp)).toBe(true)
    expect(Atomic.isRelationshipOperation(resourceOp)).toBe(false)

    if (Atomic.isRelationshipOperation(relationshipOp)) {
      // the guard narrows to operations whose ref carries `relationship`
      expectTypeOf(relationshipOp.ref.relationship).toEqualTypeOf<"author" | "comments">()
    }
  })

  it("treats add operations (no ref) as resource operations", () => {
    const addOp = decodeOperation({
      op: "add",
      data: { type: "articles", attributes: { title: "Hello", body: "" } }
    }) as Op
    expect(Atomic.isRelationshipOperation(addOp)).toBe(false)
  })
})

describe("operationPointer", () => {
  it("builds JSON pointers into the operations array", () => {
    expect(Atomic.operationPointer(0)).toBe("/atomic:operations/0")
    expect(Atomic.operationPointer(3)).toBe("/atomic:operations/3")
  })
})

// ---------------------------------------------------------------------------
// Discovering the derived operations
// ---------------------------------------------------------------------------

describe("operationsFor", () => {
  it("derives a named record of every operation for a resource", () => {
    const operations = Atomic.operationsFor(Article)

    // resource-level operations
    expect(Object.keys(operations)).toEqual(["add", "update", "remove", "relationships"])
    // relationship operations, by relationship key and kind
    expect(Object.keys(operations.relationships)).toEqual(["author", "comments"])
    expect(Object.keys(operations.relationships.author)).toEqual(["update"])
    expect(Object.keys(operations.relationships.comments)).toEqual(["add", "update", "remove"])
  })

  it("the record's schemas decode their wire forms", () => {
    const operations = Atomic.operationsFor(Article)

    const add = Schema.decodeUnknownSync(operations.add as Schema.Codec<unknown, unknown>)({
      op: "add",
      data: { type: "articles", attributes: { title: "Hello", body: "" } }
    }) as { readonly op: string }
    expect(add.op).toBe("add")

    const linkComments = Schema.decodeUnknownSync(
      operations.relationships.comments.add as Schema.Codec<unknown, unknown>
    )({
      op: "add",
      ref: { type: "articles", id: "1", relationship: "comments" },
      data: [{ type: "comments", id: "5" }]
    }) as { readonly ref: { readonly relationship: string } }
    expect(linkComments.ref.relationship).toBe("comments")
  })

  it("resources without relationships derive only resource operations", () => {
    const operations = Atomic.operationsFor(Person)
    expect(Object.keys(operations.relationships)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Pattern matching over operations with Effect's Match module
// ---------------------------------------------------------------------------

describe("Match integration (curried guards)", () => {
  type Op = Atomic.Operation<typeof Article | typeof Comment>["Type"]

  const describeOperation = (operation: Op): string =>
    Match.value(operation).pipe(
      Match.when(Atomic.targetsRelationship(Article, "comments"), (op) => `link ${op.data.length} comments`),
      Match.when(Atomic.targetsRelationship(Article, "author"), () => "set article author"),
      Match.when(Atomic.targetsRelationship(Comment, "author"), () => "set comment author"),
      Match.when(Atomic.targetsResource(Article), (op) => `${op.op} article`),
      Match.when(Atomic.targetsResource(Comment), (op) => `${op.op} comment`),
      Match.exhaustive
    )

  it("dispatches relationship and resource operations", () => {
    expect(describeOperation(decodeOperation({
      op: "add",
      ref: { type: "articles", id: "1", relationship: "comments" },
      data: [{ type: "comments", id: "5" }]
    }) as Op)).toBe("link 1 comments")

    expect(describeOperation(decodeOperation({
      op: "update",
      ref: { type: "comments", id: "5", relationship: "author" },
      data: { type: "people", id: "9" }
    }) as Op)).toBe("set comment author")

    expect(describeOperation(decodeOperation({
      op: "add",
      data: { type: "articles", attributes: { title: "Hello", body: "" } }
    }) as Op)).toBe("add article")

    expect(describeOperation(decodeOperation({
      op: "remove",
      ref: { type: "comments", id: "5" }
    }) as Op)).toBe("remove comment")
  })

  it("curried and data-first guards agree", () => {
    const operation = decodeOperation({
      op: "remove",
      ref: { type: "articles", id: "1" }
    }) as Op
    expect(Atomic.targetsResource(operation, Article)).toBe(true)
    expect(Atomic.targetsResource(Article)(operation)).toBe(true)
    expect(Atomic.targetsResource(operation, Comment)).toBe(false)
    expect(Atomic.targetsResource(Comment)(operation)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Content negotiation with the extension media type
// ---------------------------------------------------------------------------

describe("content negotiation with extensions", () => {
  const atomic = { extensions: [Atomic.EXTENSION_URI] }

  it("accepts the atomic media type when the extension is supported", () => {
    expect(Middleware.contentTypeIsAcceptable(Atomic.MEDIA_TYPE, atomic)).toBe(true)
    expect(Middleware.acceptIsAcceptable(Atomic.MEDIA_TYPE, atomic)).toBe(true)
  })

  it("rejects the atomic media type when the extension is not supported", () => {
    expect(Middleware.contentTypeIsAcceptable(Atomic.MEDIA_TYPE)).toBe(false)
    expect(Middleware.acceptIsAcceptable(Atomic.MEDIA_TYPE)).toBe(false)
  })

  it("rejects unsupported extension URIs even when others are supported", () => {
    const header = "application/vnd.api+json;ext=\"https://example.com/ext/other\""
    expect(Middleware.contentTypeIsAcceptable(header, atomic)).toBe(false)
  })

  it("accepts profile parameters regardless of extension support (per §5)", () => {
    expect(Middleware.contentTypeIsAcceptable("application/vnd.api+json;profile=\"https://example.com/p\"")).toBe(true)
    expect(Middleware.acceptIsAcceptable("application/vnd.api+json;profile=\"https://example.com/p\"")).toBe(true)
  })

  it("still rejects other media type parameters (charset, q, ...)", () => {
    expect(Middleware.contentTypeIsAcceptable("application/vnd.api+json; charset=utf-8", atomic)).toBe(false)
    expect(Middleware.acceptIsAcceptable("application/vnd.api+json;q=0.9", atomic)).toBe(false)
  })

  it("accepts unparameterised media types and wildcards as before", () => {
    expect(Middleware.contentTypeIsAcceptable("application/vnd.api+json")).toBe(true)
    expect(Middleware.contentTypeIsAcceptable(undefined)).toBe(true)
    expect(Middleware.acceptIsAcceptable("*/*")).toBe(true)
    expect(Middleware.acceptIsAcceptable("application/*;q=0.8")).toBe(true)
    expect(Middleware.acceptIsAcceptable("text/html")).toBe(false)
  })

  it("accepts an Accept header mixing parameterised and bare JSON:API media types", () => {
    const header = `${Atomic.MEDIA_TYPE}, application/vnd.api+json`
    expect(Middleware.acceptIsAcceptable(header)).toBe(true)
    expect(Middleware.acceptIsAcceptable(header, atomic)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Type-level guarantees
// ---------------------------------------------------------------------------

describe("type-level guarantees", () => {
  it("operation values from constructors are typed", () => {
    const addOp = Atomic.add(Article, { attributes: { title: "Hello", body: "" } })
    expectTypeOf(addOp.op).toEqualTypeOf<"add">()
    expectTypeOf(addOp.data.type).toEqualTypeOf<"articles">()
    expectTypeOf(addOp.data.attributes.title).toEqualTypeOf<string>()

    const removeOp = Atomic.remove(Comment, "5")
    expectTypeOf(removeOp.op).toEqualTypeOf<"remove">()

    // relationship constructors only accept declared relationship keys
    // @ts-expect-error -- "publisher" is not a relationship of Article
    Atomic.updateRelationship(Article, "1", "publisher", null)

    // to-many constructors only accept to-many keys
    // @ts-expect-error -- "author" is a to-one relationship
    Atomic.addToRelationship(Article, "1", "author", [])
  })

  it("add data attributes are required and typed", () => {
    // @ts-expect-error -- missing attributes
    Atomic.add(Article, {})
  })
})
