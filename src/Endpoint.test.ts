import { describe, expect, expectTypeOf, it } from "vitest"
import { Cause, Effect, Exit, Layer, Result, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiSchema, HttpApiTest } from "effect/unstable/httpapi"
import * as ApiError from "./ApiError.js"
import * as Document from "./Document.js"
import * as Endpoint from "./Endpoint.js"
import * as Group from "./Group.js"
import * as Handlers from "./Handlers.js"
import * as Middleware from "./Middleware.js"
import * as Query from "./Query.js"
import * as Relationship from "./Relationship.js"
import { make as Resource } from "./Resource.js"
import { MEDIA_TYPE } from "./internal/media.js"

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
  relationships: { author: Relationship.one(() => Person) }
})

const Article = Resource("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    body: Schema.String,
    createdAt: Schema.DateFromString
  },
  relationships: {
    author: Relationship.optional(() => Person),
    comments: Relationship.many(() => Comment)
  }
})

// A resource with a paginated relationship, for the related/relationship
// endpoint tests.
const Publisher = Resource("publishers", {
  attributes: { name: Schema.NonEmptyString },
  relationships: {
    catalog: Relationship.paginated(() => Article)
  }
})

class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
  fields: { id: Schema.String },
  detail: (e) => `Article ${e.id} not found`
}) {}

// ---------------------------------------------------------------------------
// Endpoints / group / api
// ---------------------------------------------------------------------------

const fetchArticle = Endpoint.get(Article, {
  include: true,
  fields: true,
  errors: [ArticleNotFound]
})

const listArticles = Endpoint.list(Article, {
  sort: true,
  page: Query.Page.Offset,
  filter: { author: Schema.String },
  meta: Schema.Struct({ total: Schema.Int })
})

const createArticle = Endpoint.create(Article)

const updateArticle = Endpoint.update(Article, { errors: [ArticleNotFound] })

const deleteArticle = Endpoint.delete(Article, { errors: [ArticleNotFound] })

// Relationship & related endpoints
const relatedAuthor = Endpoint.related(Article, "author", { errors: [ArticleNotFound] })

const relatedComments = Endpoint.related(Article, "comments", {
  page: Query.Page.Offset,
  errors: [ArticleNotFound]
})

const getCommentsRelationship = Endpoint.getRelationship(Article, "comments", { errors: [ArticleNotFound] })

const updateAuthorRelationship = Endpoint.updateRelationship(Article, "author", { errors: [ArticleNotFound] })

const addCommentsRelationship = Endpoint.addRelationship(Article, "comments", { errors: [ArticleNotFound] })

const removeCommentsRelationship = Endpoint.removeRelationship(Article, "comments", { errors: [ArticleNotFound] })

const articles = Group.make(
  Article,
  fetchArticle,
  listArticles,
  createArticle,
  updateArticle,
  deleteArticle,
  relatedAuthor,
  relatedComments,
  getCommentsRelationship,
  updateAuthorRelationship,
  addCommentsRelationship,
  removeCommentsRelationship
)

const Api = HttpApi.make("blog").add(articles)

// ---------------------------------------------------------------------------
// Sample data + handlers
// ---------------------------------------------------------------------------

const sampleArticle = Article.make({
  id: Article.Id.make("1"),
  attributes: {
    title: "Hello",
    body: "World",
    createdAt: new Date("2024-01-01T00:00:00.000Z")
  },
  relationships: {
    author: { data: { type: "people", id: Person.Id.make("9") } },
    comments: { data: [{ type: "comments", id: Comment.Id.make("5") }] }
  }
})

const samplePerson = Person.make({
  id: Person.Id.make("9"),
  attributes: { firstName: "John", lastName: "Doe" }
})

const sampleComment = Comment.make({
  id: Comment.Id.make("5"),
  attributes: { body: "Nice" },
  relationships: {
    author: { data: { type: "people", id: Person.Id.make("9") } }
  }
})

const loadArticle = (id: string): Effect.Effect<typeof Article.Type, ArticleNotFound> =>
  id === "1" ? Effect.succeed(sampleArticle) : Effect.fail(new ArticleNotFound({ id }))

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("get", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => ({
          data: article,
          ...(query.include?.includes("author") ? { included: [samplePerson] } : {})
        }))
      )
    )
    .handle("list", ({ query }) =>
      Effect.succeed({
        data: query.page?.limit === 0 ? [] : [sampleArticle],
        meta: { total: 1 }
      })
    )
    .handle("create", ({ payload }) =>
      Effect.succeed({
        data: Article.make({
          id: Article.Id.make("new-id"),
          attributes: payload.data.attributes,
          relationships: {
            author: payload.data.relationships?.author ?? { data: null },
            comments: payload.data.relationships?.comments ?? { data: [] }
          }
        })
      })
    )
    .handle("update", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => ({
          data: Article.make({
            ...article,
            attributes: { ...article.attributes, ...payload.data.attributes }
          })
        }))
      )
    )
    .handle("delete", ({ params }) => loadArticle(params.id).pipe(Effect.asVoid))
    // Related resource endpoints
    .handle("author", ({ params }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) =>
          Handlers.data(article.relationships?.author.data == null ? null : samplePerson, {
            self: Handlers.relatedLink("articles", article.id, "author")
          })
        )
      )
    )
    .handle("comments", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const all = (article.relationships?.comments.data ?? []).map(() => sampleComment)
          const offset = query.page?.offset ?? 0
          const limit = query.page?.limit ?? all.length
          return Handlers.collection(all.slice(offset, offset + limit), {
            self: Handlers.relatedLink("articles", article.id, "comments")
          })
        })
      )
    )
    // Relationship (linkage) endpoints
    .handle("commentsRelationship", ({ params }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) =>
          Handlers.linkage(article.relationships?.comments.data ?? [], {
            self: Handlers.relationshipLink("articles", article.id, "comments"),
            related: Handlers.relatedLink("articles", article.id, "comments")
          })
        )
      )
    )
    .handle("updateAuthorRelationship", ({ params, payload }) =>
      loadArticle(params.id).pipe(Effect.map(() => Handlers.linkage(payload.data)))
    )
    .handle("addCommentsRelationship", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => Handlers.linkage([...(article.relationships?.comments.data ?? []), ...payload.data]))
      )
    )
    .handle("removeCommentsRelationship", ({ params }) => loadArticle(params.id).pipe(Effect.asVoid))
)

const findFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const result = Cause.findError(cause)
  return Result.isSuccess(result) ? result.success : undefined
}

const buildClient = HttpApiTest.groups(Api, ["articles"])

const withHandlers = <A, E>(effect: Effect.Effect<A, E, any>) =>
  effect.pipe(Effect.scoped, Effect.provide(ArticlesLive), Effect.provide(Middleware.layer)) as Effect.Effect<
    A,
    E,
    never
  >

// ---------------------------------------------------------------------------
// Endpoint shapes
// ---------------------------------------------------------------------------

describe("endpoint conventions", () => {
  it("derives conventional names, methods and paths", () => {
    expect(fetchArticle.identifier).toBe("get")
    expect(fetchArticle.method).toBe("GET")
    expect(fetchArticle.path).toBe("/articles/:id")

    expect(listArticles.identifier).toBe("list")
    expect(listArticles.method).toBe("GET")
    expect(listArticles.path).toBe("/articles")

    expect(createArticle.identifier).toBe("create")
    expect(createArticle.method).toBe("POST")
    expect(createArticle.path).toBe("/articles")

    expect(updateArticle.identifier).toBe("update")
    expect(updateArticle.method).toBe("PATCH")
    expect(updateArticle.path).toBe("/articles/:id")

    expect(deleteArticle.identifier).toBe("delete")
    expect(deleteArticle.method).toBe("DELETE")
    expect(deleteArticle.path).toBe("/articles/:id")
  })

  it("allows overriding name and path", () => {
    const search = Endpoint.list(Article, { name: "search", path: "/articles/search" })
    expect(search.identifier).toBe("search")
    expect(search.path).toBe("/articles/search")
  })

  it("attaches the JSON:API protocol middlewares to every endpoint", () => {
    for (const endpoint of [fetchArticle, listArticles, createArticle, updateArticle, deleteArticle]) {
      const middlewareIds = [...endpoint.middlewares].map((m) => m.key)
      expect(middlewareIds).toContain("effect-jsonapi/ContentNegotiation")
      expect(middlewareIds).toContain("effect-jsonapi/SchemaErrors")
    }
  })

  it("groups take the resource type as their identifier", () => {
    expect(articles.identifier).toBe("articles")
    expect(Object.keys(articles.endpoints)).toEqual([
      "get",
      "list",
      "create",
      "update",
      "delete",
      "author",
      "comments",
      "commentsRelationship",
      "updateAuthorRelationship",
      "addCommentsRelationship",
      "removeCommentsRelationship"
    ])
  })

  it("groups can be named directly for heterogeneous endpoints", () => {
    const group = Group.make("search", Endpoint.collection([Article, Person], { name: "search", path: "/search" }))
    expect(group.identifier).toBe("search")
    expect(Object.keys(group.endpoints)).toEqual(["search"])
  })
})

// ---------------------------------------------------------------------------
// Heterogeneous (collection) endpoints
// ---------------------------------------------------------------------------

describe("Endpoint.collection", () => {
  const searchEndpoint = Endpoint.collection([Article, Person], {
    name: "search",
    path: "/search",
    include: true,
    fields: true,
    filter: { q: Schema.String },
    page: Query.Page.Offset,
    meta: Schema.Struct({ total: Schema.Int })
  })

  it("uses the given name/path with GET", () => {
    expect(searchEndpoint.identifier).toBe("search")
    expect(searchEndpoint.method).toBe("GET")
    expect(searchEndpoint.path).toBe("/search")
  })

  it("names other heterogeneous collections (e.g. feeds)", () => {
    const feed = Endpoint.collection([Article, Comment], { name: "feed", path: "/feed" })
    expect(feed.identifier).toBe("feed")
    expect(feed.path).toBe("/feed")
  })

  it("attaches the JSON:API protocol middlewares", () => {
    const middlewareIds = [...searchEndpoint.middlewares].map((m) => m.key)
    expect(middlewareIds).toContain("effect-jsonapi/ContentNegotiation")
    expect(middlewareIds).toContain("effect-jsonapi/SchemaErrors")
  })

  it("success document data is the union of the searched resources", () => {
    // the success schema decodes mixed collections, discriminated by type
    const successSchema = [...searchEndpoint.success][0]!
    const decoded = Schema.decodeUnknownSync(successSchema as Schema.Codec<unknown, unknown>)({
      data: [
        {
          type: "articles",
          id: "1",
          attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
        },
        { type: "people", id: "9", attributes: { firstName: "John", lastName: "Doe" } }
      ],
      meta: { total: 2 }
    }) as { readonly data: ReadonlyArray<{ readonly type: string }> }
    expect(decoded.data.map((item) => item.type)).toEqual(["articles", "people"])
  })

  it("rejects resources outside the searched union", () => {
    const successSchema = [...searchEndpoint.success][0]!
    expect(() =>
      Schema.decodeUnknownSync(successSchema as Schema.Codec<unknown, unknown>)({
        data: [{ type: "comments", id: "5", attributes: { body: "Nice" } }],
        meta: { total: 1 }
      })
    ).toThrow()
  })

  it("query spans both resources: fieldsets for each type, include across graphs", () => {
    const query = searchEndpoint.query as Schema.Codec<unknown, unknown>
    const decoded = Schema.decodeUnknownSync(query)({
      include: "author,comments.author",
      "fields[articles]": "title",
      "fields[people]": "firstName",
      "filter[q]": "bikeshed",
      "page[offset]": "0",
      "page[limit]": "10"
    }) as any
    expect(decoded).toEqual({
      include: ["author", "comments.author"],
      fields: { articles: ["title"], people: ["firstName"] },
      filter: { q: "bikeshed" },
      page: { offset: 0, limit: 10 }
    })
  })
})

// ---------------------------------------------------------------------------
// Relationship & related endpoints
// ---------------------------------------------------------------------------

describe("relationship endpoint conventions", () => {
  it("related derives conventional names, methods and paths", () => {
    expect(relatedAuthor.identifier).toBe("author")
    expect(relatedAuthor.method).toBe("GET")
    expect(relatedAuthor.path).toBe("/articles/:id/author")

    expect(relatedComments.identifier).toBe("comments")
    expect(relatedComments.method).toBe("GET")
    expect(relatedComments.path).toBe("/articles/:id/comments")
  })

  it("relationship endpoints derive conventional names, methods and paths", () => {
    expect(getCommentsRelationship.identifier).toBe("commentsRelationship")
    expect(getCommentsRelationship.method).toBe("GET")
    expect(getCommentsRelationship.path).toBe("/articles/:id/relationships/comments")

    expect(updateAuthorRelationship.identifier).toBe("updateAuthorRelationship")
    expect(updateAuthorRelationship.method).toBe("PATCH")
    expect(updateAuthorRelationship.path).toBe("/articles/:id/relationships/author")

    expect(addCommentsRelationship.identifier).toBe("addCommentsRelationship")
    expect(addCommentsRelationship.method).toBe("POST")
    expect(addCommentsRelationship.path).toBe("/articles/:id/relationships/comments")

    expect(removeCommentsRelationship.identifier).toBe("removeCommentsRelationship")
    expect(removeCommentsRelationship.method).toBe("DELETE")
    expect(removeCommentsRelationship.path).toBe("/articles/:id/relationships/comments")
  })

  it("allows overriding name and path", () => {
    const custom = Endpoint.related(Article, "author", {
      name: "articleAuthor",
      path: "/articles/:id/writer"
    })
    expect(custom.identifier).toBe("articleAuthor")
    expect(custom.path).toBe("/articles/:id/writer")
  })

  it("attaches the JSON:API protocol middlewares", () => {
    for (const endpoint of [
      relatedAuthor,
      relatedComments,
      getCommentsRelationship,
      updateAuthorRelationship,
      addCommentsRelationship,
      removeCommentsRelationship
    ]) {
      const middlewareIds = [...endpoint.middlewares].map((m) => m.key)
      expect(middlewareIds).toContain("effect-jsonapi/ContentNegotiation")
      expect(middlewareIds).toContain("effect-jsonapi/SchemaErrors")
    }
  })

  it("add/remove relationship endpoints only accept to-many relationship names", () => {
    // `comments` is to-many — fine.
    Endpoint.addRelationship(Article, "comments")
    Endpoint.removeRelationship(Article, "comments")
    // @ts-expect-error -- `author` is to-one; the spec defines POST only for to-many
    Endpoint.addRelationship(Article, "author")
    // @ts-expect-error -- `author` is to-one; the spec defines DELETE only for to-many
    Endpoint.removeRelationship(Article, "author")
  })

  it("relationship names must exist on the resource", () => {
    // Unknown names are compile errors *and* descriptive construction errors.
    expect(() =>
      // @ts-expect-error -- `publisher` is not a relationship of Article
      Endpoint.related(Article, "publisher")
    ).toThrow(/Unknown relationship "publisher"/)
    expect(() =>
      // @ts-expect-error -- `publisher` is not a relationship of Article
      Endpoint.getRelationship(Article, "publisher")
    ).toThrow(/Unknown relationship "publisher"/)
  })

  it("paginated relationships get related collection endpoints", () => {
    const catalog = Endpoint.related(Publisher, "catalog", { page: Query.Page.Offset })
    expect(catalog.identifier).toBe("catalog")
    expect(catalog.method).toBe("GET")
    expect(catalog.path).toBe("/publishers/:id/catalog")

    // ... and their linkage endpoint pages through identifiers.
    const catalogLinkage = Endpoint.getRelationship(Publisher, "catalog", { page: Query.Page.Offset })
    expect(catalogLinkage.path).toBe("/publishers/:id/relationships/catalog")
  })
})

describe("relationship endpoint schemas", () => {
  it("getRelationship success is a linkage document (identifiers, not resources)", () => {
    const successSchema = [...getCommentsRelationship.success][0]!
    const decoded = Schema.decodeUnknownSync(successSchema as Schema.Codec<unknown, unknown>)({
      data: [{ type: "comments", id: "5" }]
    }) as { readonly data: ReadonlyArray<{ readonly type: string; readonly id: string }> }
    expect(decoded.data).toEqual([{ type: "comments", id: "5" }])

    // Full resource objects are not linkage
    expect(() =>
      Schema.decodeUnknownSync(successSchema as Schema.Codec<unknown, unknown>)(
        { data: [{ type: "comments", id: "5", attributes: { body: "Nice" } }] },
        { onExcessProperty: "error" }
      )
    ).toThrow()
  })

  it("updateRelationship payload follows the relationship kind", () => {
    // `author` is optional → payload data may be null (clearing the relationship)
    const authorPayload = [...updateAuthorRelationship.payload.values()][0]!.schemas[0]!
    const cleared = Schema.decodeUnknownSync(authorPayload as Schema.Codec<unknown, unknown>)({ data: null }) as {
      readonly data: null
    }
    expect(cleared.data).toBeNull()

    // `one` relationships can't be cleared
    const updateCommentAuthor = Endpoint.updateRelationship(Comment, "author")
    const commentAuthorPayload = [...updateCommentAuthor.payload.values()][0]!.schemas[0]!
    expect(() =>
      Schema.decodeUnknownSync(commentAuthorPayload as Schema.Codec<unknown, unknown>)({ data: null })
    ).toThrow()
    const replaced = Schema.decodeUnknownSync(commentAuthorPayload as Schema.Codec<unknown, unknown>)({
      data: { type: "people", id: "9" }
    }) as { readonly data: { readonly id: string } }
    expect(replaced.data.id).toBe("9")
  })

  it("addRelationship payload is an identifier array of the target type", () => {
    const payloadSchema = [...addCommentsRelationship.payload.values()][0]!.schemas[0]!
    const decoded = Schema.decodeUnknownSync(payloadSchema as Schema.Codec<unknown, unknown>)({
      data: [{ type: "comments", id: "12" }]
    }) as { readonly data: ReadonlyArray<{ readonly id: string }> }
    expect(decoded.data[0]?.id).toBe("12")

    // Wrong target type fails
    expect(() =>
      Schema.decodeUnknownSync(payloadSchema as Schema.Codec<unknown, unknown>)({
        data: [{ type: "people", id: "9" }]
      })
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Atomic operations endpoints
// ---------------------------------------------------------------------------

describe("Endpoint.operations", () => {
  const operationsEndpoint = Endpoint.operations([Article, Comment], {
    errors: [ArticleNotFound]
  })

  it("uses conventional name/path with POST", () => {
    expect(operationsEndpoint.identifier).toBe("operations")
    expect(operationsEndpoint.method).toBe("POST")
    expect(operationsEndpoint.path).toBe("/operations")
  })

  it("allows overriding name and path", () => {
    const bulk = Endpoint.operations([Article], { name: "bulk", path: "/bulk" })
    expect(bulk.identifier).toBe("bulk")
    expect(bulk.path).toBe("/bulk")
  })

  it("attaches the JSON:API protocol middlewares", () => {
    const middlewareIds = [...operationsEndpoint.middlewares].map((m) => m.key)
    expect(middlewareIds).toContain("effect-jsonapi/ContentNegotiation")
    expect(middlewareIds).toContain("effect-jsonapi/SchemaErrors")
  })

  it("payload accepts operations across all of the given resources", () => {
    const payloadSchema = [...operationsEndpoint.payload.values()][0]!.schemas[0]!
    const decoded = Schema.decodeUnknownSync(payloadSchema as Schema.Codec<unknown, unknown>)({
      "atomic:operations": [
        {
          op: "add",
          data: {
            // Article's relationships are `optional` / `many` here, so an add
            // operation with attributes only is legal
            type: "articles",
            attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
          }
        },
        // Comment's author is `one` (required), so its add operation must carry it
        {
          op: "add",
          data: {
            type: "comments",
            attributes: { body: "Nice" },
            relationships: { author: { data: { type: "people", id: "9" } } }
          }
        },
        { op: "remove", ref: { type: "comments", id: "5" } }
      ]
    }) as { readonly "atomic:operations": ReadonlyArray<unknown> }
    expect(decoded["atomic:operations"]).toHaveLength(3)
  })

  it("rejects add operations missing required (`one`) relationships", () => {
    const payloadSchema = [...operationsEndpoint.payload.values()][0]!.schemas[0]!
    expect(() =>
      Schema.decodeUnknownSync(payloadSchema as Schema.Codec<unknown, unknown>)({
        "atomic:operations": [{ op: "add", data: { type: "comments", attributes: { body: "No author" } } }]
      })
    ).toThrow()
  })

  it("success documents results as the union of the given resources", () => {
    const successSchema = [...operationsEndpoint.success][0]!
    const decoded = Schema.decodeUnknownSync(successSchema as Schema.Codec<unknown, unknown>)({
      "atomic:results": [
        {
          data: {
            type: "articles",
            id: "1",
            attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
          }
        },
        {}
      ]
    }) as { readonly "atomic:results": ReadonlyArray<{ readonly data?: { readonly type: string } }> }
    expect(decoded["atomic:results"][0]?.data?.type).toBe("articles")
    expect(decoded["atomic:results"][1]?.data).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// HTTP round-trips through the in-memory client
// ---------------------------------------------------------------------------

describe("HTTP round-trip via HttpApiTest", () => {
  it("fetches a single resource document", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} })
        })
      )
    )

    expect(result.data).toMatchObject({ type: "articles", id: "1" })
    // `data` is non-null now — the resource itself, no optional chaining needed
    expect(result.data.attributes.title).toBe("Hello")
    // The branded id type flows through the client
    expectTypeOf<typeof result.data.id>().toEqualTypeOf<typeof Article.Id.Type>()
    expect(result.data.attributes.createdAt).toBeInstanceOf(Date)
  })

  it("serves compound documents when include is requested", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.get({
            params: { id: Article.Id.make("1") },
            query: { include: ["author"] }
          })
        })
      )
    )

    expect(result.included).toHaveLength(1)
    expect(result.included?.[0]).toMatchObject({ type: "people", id: "9" })
  })

  it("lists a collection document with typed query params", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.list({
            query: {
              sort: [{ field: "createdAt", direction: "desc" }],
              page: { offset: 0, limit: 10 },
              filter: { author: "9" }
            }
          })
        })
      )
    )

    expect(result.data).toHaveLength(1)
    expect(result.meta?.total).toBe(1)
  })

  it("creates a resource from a JSON:API payload (201)", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.create({
            payload: {
              data: {
                type: "articles",
                lid: "temp-1",
                attributes: {
                  title: "New article",
                  body: "Contents",
                  createdAt: new Date("2024-06-01T00:00:00.000Z")
                }
              }
            }
          })
        })
      )
    )

    expect(result.data).toMatchObject({ type: "articles", id: "new-id" })
    expect(result.data.attributes.title).toBe("New article")
  })

  it("updates a resource with a partial attributes payload", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.update({
            params: { id: Article.Id.make("1") },
            payload: {
              data: {
                type: "articles",
                id: Article.Id.make("1"),
                attributes: { title: "Updated title" }
              }
            }
          })
        })
      )
    )

    expect(result.data.attributes.title).toBe("Updated title")
    expect(result.data.attributes.body).toBe("World")
  })

  it("deletes a resource (204, no content)", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.delete({ params: { id: Article.Id.make("1") } })
        })
      )
    )
    expect(result).toBeUndefined()
  })

  it("surfaces domain errors as typed tagged errors on the client", async () => {
    const exit = await Effect.runPromiseExit(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.get({ params: { id: Article.Id.make("missing") }, query: {} })
        })
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = findFailure(exit.cause)
      expect(error).toBeInstanceOf(ArticleNotFound)
      expect((error as ArticleNotFound).id).toBe("missing")
    }
  })

  it("recovers from domain errors with catchTag", async () => {
    const recovered = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles
            .get({ params: { id: Article.Id.make("missing") }, query: {} })
            .pipe(Effect.catchTag("ArticleNotFound", (error) => Effect.succeed(`not found: ${error.id}`)))
        })
      )
    )

    expect(recovered).toBe("not found: missing")
  })

  it("rejects unknown include paths with a 400 BadRequest", async () => {
    const exit = await Effect.runPromiseExit(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.get({
            params: { id: Article.Id.make("1") },
            // Bypass client-side validation to test the server's response
            query: { include: ["publisher"] } as never
          })
        })
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("fetches related to-one resources (GET /articles/:id/author)", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.author({ params: { id: Article.Id.make("1") }, query: {} })
        })
      )
    )

    expect(result.data).toMatchObject({ type: "people", id: "9" })
    expect(result.links?.self).toBe("/articles/1/author")
  })

  it("fetches related to-many resources with pagination (GET /articles/:id/comments)", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.comments({
            params: { id: Article.Id.make("1") },
            query: { page: { offset: 0, limit: 10 } }
          })
        })
      )
    )

    expect(result.data).toHaveLength(1)
    expect(result.data[0]).toMatchObject({ type: "comments", id: "5" })
    // Full resource objects, not just identifiers
    expect(result.data[0]?.attributes.body).toBe("Nice")
  })

  it("fetches relationship linkage (GET /articles/:id/relationships/comments)", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.commentsRelationship({
            params: { id: Article.Id.make("1") },
            query: {}
          })
        })
      )
    )

    // Identifiers only — no attributes
    expect(result.data).toEqual([{ type: "comments", id: "5" }])
    expect(result.links?.self).toBe("/articles/1/relationships/comments")
    expect(result.links?.related).toBe("/articles/1/comments")
  })

  it("replaces a to-one relationship (PATCH /articles/:id/relationships/author)", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.updateAuthorRelationship({
            params: { id: Article.Id.make("1") },
            payload: { data: Person.ref("42") }
          })
        })
      )
    )

    expect(result.data).toEqual({ type: "people", id: "42" })
  })

  it("clears an optional to-one relationship (PATCH with null data)", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.updateAuthorRelationship({
            params: { id: Article.Id.make("1") },
            payload: { data: null }
          })
        })
      )
    )

    expect(result.data).toBeNull()
  })

  it("adds to a to-many relationship (POST /articles/:id/relationships/comments)", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.addCommentsRelationship({
            params: { id: Article.Id.make("1") },
            payload: { data: [Comment.ref("12")] }
          })
        })
      )
    )

    // Existing linkage plus the added identifier
    expect(result.data).toEqual([
      { type: "comments", id: "5" },
      { type: "comments", id: "12" }
    ])
  })

  it("removes from a to-many relationship (DELETE /articles/:id/relationships/comments, 204)", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.removeCommentsRelationship({
            params: { id: Article.Id.make("1") },
            payload: { data: [Comment.ref("5")] }
          })
        })
      )
    )

    expect(result).toBeUndefined()
  })

  it("relationship endpoints surface domain errors as typed tagged errors", async () => {
    const exit = await Effect.runPromiseExit(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.commentsRelationship({
            params: { id: Article.Id.make("missing") },
            query: {}
          })
        })
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(findFailure(exit.cause)).toBeInstanceOf(ArticleNotFound)
    }
  })
})

// ---------------------------------------------------------------------------
// Type-level guarantees
// ---------------------------------------------------------------------------

describe("type-level guarantees", () => {
  it("handler error channels are restricted to declared errors", () => {
    // fetch declares ArticleNotFound, so its handler may fail with it;
    // create declares no errors, so its error channel is never.
    type FetchError = typeof fetchArticle extends { readonly "~Error": { readonly Type: infer E } } ? E : never
    expectTypeOf<ArticleNotFound>().toMatchTypeOf<FetchError>()
  })

  it("query schemas are attached to fetch/list endpoints", () => {
    expect(fetchArticle.query).toBeDefined()
    expect(listArticles.query).toBeDefined()
    // create/update/delete have no query parameters
    expect(createArticle.query).toBeUndefined()
    expect(updateArticle.query).toBeUndefined()
    expect(deleteArticle.query).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Whole-resource generation — Endpoint.resource / Group.resource
// ---------------------------------------------------------------------------

describe("Endpoint.resource / Group.resource", () => {
  // Article here has `author: optional(Person)` (to-one) and
  // `comments: many(Comment)` (to-many), so the full generated set is:
  const fullEndpointNames = [
    "get",
    "list",
    "create",
    "update",
    "delete",
    "author",
    "authorRelationship",
    "updateAuthorRelationship",
    "comments",
    "commentsRelationship",
    "updateCommentsRelationship",
    "addCommentsRelationship",
    "removeCommentsRelationship"
  ]

  it("Endpoint.resource emits the full CRUD + relationship endpoint set in order", () => {
    const endpoints = Endpoint.resource(Article, { errors: [ArticleNotFound] })
    expect(endpoints.map((endpoint) => endpoint.identifier)).toEqual(fullEndpointNames)
  })

  it("Group.resource builds a group named after the resource with that endpoint set", () => {
    const group = Group.resource(Article, { errors: [ArticleNotFound] })
    expect(group.identifier).toBe("articles")
    expect(Object.keys(group.endpoints)).toEqual(fullEndpointNames)
  })

  it("derives query parameters: list & to-many related carry a query schema; create/update/delete don't", () => {
    const endpoints = Endpoint.resource(Article, {
      page: Query.Page.Offset,
      filter: { author: Schema.optionalKey(Schema.String) }
    })
    const byName = Object.fromEntries(endpoints.map((endpoint) => [endpoint.identifier, endpoint]))
    expect(byName.list!.query).toBeDefined()
    expect(byName.comments!.query).toBeDefined() // paginated related collection
    expect(byName.author!.query).toBeDefined() // include/fields on the to-one related URL
    expect(byName.create!.query).toBeUndefined()
    expect(byName.update!.query).toBeUndefined()
    expect(byName.delete!.query).toBeUndefined()
  })

  it("conventional methods and paths", () => {
    const byName = Object.fromEntries(Endpoint.resource(Article).map((endpoint) => [endpoint.identifier, endpoint]))
    expect([byName.delete!.method, byName.delete!.path]).toEqual(["DELETE", "/articles/:id"])
    expect([byName.comments!.method, byName.comments!.path]).toEqual(["GET", "/articles/:id/comments"])
    expect([byName.addCommentsRelationship!.method, byName.addCommentsRelationship!.path]).toEqual([
      "POST",
      "/articles/:id/relationships/comments"
    ])
  })

  it("`endpoints` object omits ops set to `false`; `relationships: false` drops relationship endpoints", () => {
    const group = Group.resource(Article, {
      endpoints: { create: false, update: false, delete: false },
      relationships: false
    })
    expect(Object.keys(group.endpoints)).toEqual(["get", "list"])
  })

  it("`relationships: false` keeps CRUD but drops relationship endpoints", () => {
    const group = Group.resource(Article, { relationships: false })
    expect(Object.keys(group.endpoints)).toEqual(["get", "list", "create", "update", "delete"])
  })

  it("`endpoints` object can rename/repath and re-error individual endpoints", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, {
        endpoints: {
          get: { name: "show", path: "/articles/:id/full" },
          create: { errors: [ArticleNotFound] }
        }
      }).map((endpoint) => [endpoint.identifier, endpoint])
    )
    expect(byName.show!.method).toBe("GET")
    expect(byName.show!.path).toBe("/articles/:id/full")
    // the renamed endpoint replaces the default "get" name
    expect(byName.get).toBeUndefined()
  })

  it("`relationships` object excludes named relationships (others stay)", () => {
    const group = Group.resource(Article, { relationships: { comments: false } })
    const keys = Object.keys(group.endpoints)
    // author relationship endpoints remain; comments' are gone
    expect(keys).toContain("author")
    expect(keys).not.toContain("comments")
    expect(keys).not.toContain("addCommentsRelationship")
  })

  it("per-endpoint `include: false` removes `?include=` for just that endpoint", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, {
        include: true,
        endpoints: { get: { include: false } }
      }).map((endpoint) => [endpoint.identifier, endpoint])
    )
    const getQuery = byName.get!.query as Schema.Codec<unknown, unknown>
    const listQuery = byName.list!.query as Schema.Codec<unknown, unknown>
    // list keeps `include`; get dropped it (the param is gone from get's query)
    expect((Schema.decodeUnknownSync(listQuery)({ include: "author" }) as { include?: unknown }).include).toEqual([
      "author"
    ])
    expect((Schema.decodeUnknownSync(getQuery)({ include: "author" }) as { include?: unknown }).include).toBeUndefined()
  })

  it("`meta` as a function extends the resource's base meta rather than overriding it", () => {
    const Widget = Resource("widgets", {
      attributes: { name: Schema.NonEmptyString },
      meta: Schema.Struct({ revision: Schema.Int })
    })
    const byName = Object.fromEntries(
      Endpoint.resource(Widget, {
        relationships: false,
        meta: (base) => Schema.Struct({ ...base.fields, total: Schema.Int })
      }).map((endpoint) => [endpoint.identifier, endpoint])
    )
    // the list success document's meta now carries both the base `revision` and the added `total`
    const successSchema = [...byName.list!.success][0]!
    const decoded = Schema.decodeUnknownSync(successSchema as Schema.Codec<unknown, unknown>)({
      data: [{ type: "widgets", id: "1", attributes: { name: "Gear" } }],
      meta: { revision: 3, total: 1 }
    }) as { readonly meta: { readonly revision: number; readonly total: number } }
    expect(decoded.meta).toEqual({ revision: 3, total: 1 })
  })

  it("round-trips through a fully generated group (every endpoint handled & callable)", async () => {
    // Comment has a single `author: one(Person)` relationship → 8 endpoints.
    const commentsGroup = Group.resource(Comment)
    const CommentApi = HttpApi.make("blog").add(commentsGroup)

    const CommentsLive = HttpApiBuilder.group(CommentApi, "comments", (handlers) =>
      handlers
        .handle("get", () => Effect.succeed(Handlers.data(sampleComment)))
        .handle("list", () => Effect.succeed(Handlers.collection([sampleComment])))
        .handle("create", ({ payload }) =>
          Effect.succeed(
            Handlers.data(
              Comment.make({
                id: Comment.Id.make("new"),
                attributes: payload.data.attributes,
                relationships: { author: payload.data.relationships.author }
              })
            )
          )
        )
        .handle("update", () => Effect.succeed(Handlers.data(sampleComment)))
        .handle("delete", () => Effect.void)
        .handle("author", ({ params }) =>
          Effect.succeed(Handlers.data(samplePerson, { self: Handlers.relatedLink("comments", params.id, "author") }))
        )
        .handle("authorRelationship", ({ params }) =>
          Effect.succeed(
            Handlers.linkage(sampleComment.relationships!.author.data, {
              self: Handlers.relationshipLink("comments", params.id, "author"),
              related: Handlers.relatedLink("comments", params.id, "author")
            })
          )
        )
        .handle("updateAuthorRelationship", ({ payload }) => Effect.succeed(Handlers.linkage(payload.data)))
    )

    const withComments = <A, E>(effect: Effect.Effect<A, E, any>) =>
      effect.pipe(Effect.scoped, Effect.provide(CommentsLive), Effect.provide(Middleware.layer)) as Effect.Effect<
        A,
        E,
        never
      >

    const result = await Effect.runPromise(
      withComments(
        Effect.gen(function* () {
          const client = yield* HttpApiTest.groups(CommentApi, ["comments"])
          const fetched = yield* client.comments.get({ params: { id: Comment.Id.make("5") }, query: {} })
          const author = yield* client.comments.author({ params: { id: Comment.Id.make("5") }, query: {} })
          const deleted = yield* client.comments.delete({ params: { id: Comment.Id.make("5") } })
          return { fetched, author, deleted }
        })
      )
    )

    expect(result.fetched.data).toMatchObject({ type: "comments", id: "5" })
    expect(result.author.data).toMatchObject({ type: "people", id: "9" })
    expect(result.deleted).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Write-payload override (Endpoint.create / Endpoint.update)
// ---------------------------------------------------------------------------

// Reads the payload schema off a constructed endpoint, as the relationship
// payload tests above do.
const payloadSchemaOf = (endpoint: {
  readonly payload: ReadonlyMap<string, { readonly schemas: ReadonlyArray<unknown> }>
}) => [...endpoint.payload.values()][0]!.schemas[0]! as Schema.Codec<unknown, unknown>

describe("Endpoint.create / Endpoint.update payload override", () => {
  const envelopedCreate = {
    data: { type: "articles", attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" } }
  }
  const flatCreate = { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }

  it("defaults create to the JSON:API envelope (regression: unchanged without `payload`)", () => {
    const schema = payloadSchemaOf(Endpoint.create(Article))
    expect(Schema.decodeUnknownSync(schema)(envelopedCreate)).toMatchObject({
      data: { type: "articles", attributes: { title: "Hello" } }
    })
    // …and still rejects the flat shape, exactly as before this option existed.
    expect(() => Schema.decodeUnknownSync(schema)(flatCreate)).toThrow()
  })

  it("defaults update to the JSON:API envelope (regression: unchanged without `payload`)", () => {
    const schema = payloadSchemaOf(Endpoint.update(Article))
    expect(
      Schema.decodeUnknownSync(schema)({ data: { type: "articles", id: "1", attributes: { title: "Hi" } } })
    ).toMatchObject({ data: { type: "articles", id: "1" } })
    expect(() => Schema.decodeUnknownSync(schema)({ id: "1", title: "Hi" })).toThrow()
  })

  it("accepts a flat command input when `payload` is supplied", () => {
    const schema = payloadSchemaOf(Endpoint.create(Article, { payload: Article.createInput }))
    expect(Schema.decodeUnknownSync(schema)(flatCreate)).toMatchObject({ title: "Hello", body: "World" })
    // the envelope is no longer the contract
    expect(() => Schema.decodeUnknownSync(schema)(envelopedCreate)).toThrow()
  })

  it("accepts a flat update input, keeping the id as the payload's validation authority", () => {
    const schema = payloadSchemaOf(Endpoint.update(Article, { payload: Article.updateInput }))
    expect(Schema.decodeUnknownSync(schema)({ id: "1", title: "Hi" })).toMatchObject({ id: "1", title: "Hi" })
  })

  it("changes only the payload — name, method, path, params and middleware are untouched", () => {
    const flat = Endpoint.update(Article, { payload: Article.updateInput })
    const enveloped = Endpoint.update(Article)
    expect([flat.identifier, flat.method, flat.path]).toEqual([enveloped.identifier, enveloped.method, enveloped.path])
    expect([...flat.middlewares].map((m) => m.key)).toEqual([...enveloped.middlewares].map((m) => m.key))
  })

  it("types the overridden payload as the supplied schema", () => {
    const flat = Endpoint.create(Article, { payload: Article.createInput })
    expectTypeOf<HttpApiEndpoint.Payload<typeof flat>["Type"]>().toEqualTypeOf<typeof Article.createInput.Type>()

    const enveloped = Endpoint.create(Article)
    expectTypeOf<HttpApiEndpoint.Payload<typeof enveloped>["Type"]>().toEqualTypeOf<typeof Article.createPayload.Type>()
  })

  it("threads through Endpoint.resource's per-endpoint create/update config", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, {
        relationships: false,
        endpoints: {
          create: { payload: Article.createInput },
          update: { payload: Article.updateInput }
        }
      }).map((endpoint) => [endpoint.identifier, endpoint])
    )
    expect(Schema.decodeUnknownSync(payloadSchemaOf(byName.create!))(flatCreate)).toMatchObject({ title: "Hello" })
    expect(Schema.decodeUnknownSync(payloadSchemaOf(byName.update!))({ id: "1", title: "Hi" })).toMatchObject({
      id: "1"
    })
  })

  it("leaves Endpoint.resource's write payloads enveloped when no override is given (regression)", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, { relationships: false }).map((endpoint) => [endpoint.identifier, endpoint])
    )
    expect(Schema.decodeUnknownSync(payloadSchemaOf(byName.create!))(envelopedCreate)).toMatchObject({
      data: { type: "articles" }
    })
    expect(() => Schema.decodeUnknownSync(payloadSchemaOf(byName.create!))(flatCreate)).toThrow()
  })

  it("threads through Group.resource, typed end to end", () => {
    const group = Group.resource(Article, {
      relationships: false,
      endpoints: { create: { payload: Article.createInput }, update: false, delete: false }
    })
    expectTypeOf<HttpApiEndpoint.Payload<typeof group.endpoints.create>["Type"]>().toEqualTypeOf<
      typeof Article.createInput.Type
    >()
  })
})

describe("HTTP round-trip with a flat write payload", () => {
  const FlatApi = HttpApi.make("flat-blog").add(
    Group.make(
      Article,
      Endpoint.create(Article, { payload: Article.createInput }),
      Endpoint.update(Article, { payload: Article.updateInput, errors: [ArticleNotFound] })
    )
  )

  const FlatLive = HttpApiBuilder.group(FlatApi, "articles", (handlers) =>
    handlers
      .handle("create", ({ payload }) =>
        Effect.succeed({
          data: Article.make({
            id: Article.Id.make("new-id"),
            // `payload` is the flat attributes struct — no `.data` envelope
            attributes: payload,
            relationships: { author: { data: null }, comments: { data: [] } }
          })
        })
      )
      .handle("update", ({ params, payload }) =>
        loadArticle(params.id).pipe(
          Effect.map((article) => ({
            data: Article.make({
              ...article,
              attributes: {
                ...article.attributes,
                ...(payload.title !== undefined ? { title: payload.title } : {})
              }
            })
          }))
        )
      )
  )

  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
      effect.pipe(Effect.scoped, Effect.provide(FlatLive), Effect.provide(Middleware.layer)) as Effect.Effect<
        A,
        E,
        never
      >
    )

  it("creates from a flat body and still answers with a JSON:API document (201)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(FlatApi, ["articles"])
        return yield* client.articles.create({
          payload: { title: "New article", body: "Contents", createdAt: new Date("2024-06-01T00:00:00.000Z") }
        })
      })
    )

    expect(result.data).toMatchObject({ type: "articles", id: "new-id" })
    expect(result.data.attributes.title).toBe("New article")
    expect(result.data.attributes.createdAt).toBeInstanceOf(Date)
  })

  it("updates from a flat body carrying the id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(FlatApi, ["articles"])
        return yield* client.articles.update({
          params: { id: Article.Id.make("1") },
          payload: { id: Article.Id.make("1"), title: "Updated" }
        })
      })
    )

    expect(result.data.attributes.title).toBe("Updated")
    // the untouched attribute survives
    expect(result.data.attributes.body).toBe("World")
  })
})

// ---------------------------------------------------------------------------
// Delete success override (Endpoint.delete)
// ---------------------------------------------------------------------------

describe("Endpoint.delete success override", () => {
  // The tombstone contract: a soft delete answers with the resource document
  // rather than an empty 204 body.
  const Tombstone = Article.document()

  const TombstoneApi = HttpApi.make("tombstone-blog").add(
    Group.make(Article, Endpoint.delete(Article, { success: Tombstone, errors: [ArticleNotFound] }))
  )

  const TombstoneLive = HttpApiBuilder.group(TombstoneApi, "articles", (handlers) =>
    handlers.handle("delete", ({ params }) => loadArticle(params.id).pipe(Effect.map((article) => ({ data: article }))))
  )

  // The 204 default and a document success differ only in the response, so the
  // assertions are on the wire: status and content type.
  const request = async (api: unknown, live: Layer.Layer<any, any, any>, url: string) => {
    const appLayer = HttpApiBuilder.layer(api as never).pipe(
      Layer.provide(live),
      Layer.provide(Middleware.layer)
    ) as unknown as Layer.Layer<never, never, HttpRouter.HttpRouter>
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer)
    try {
      const response = await handler(new Request(url, { method: "DELETE" }))
      const text = await response.text()
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: text === "" ? undefined : (JSON.parse(text) as any)
      }
    } finally {
      await dispose()
    }
  }

  it("answers 204 with an empty body when no `success` is given (regression: unchanged default)", async () => {
    const response = await request(Api, ArticlesLive, "http://localhost/articles/1")
    expect(response.status).toBe(204)
    expect(response.body).toBeUndefined()
  })

  it("answers 200 with the tombstone document when `success` is a resource document", async () => {
    const response = await request(TombstoneApi, TombstoneLive, "http://localhost/articles/1")
    expect(response.status).toBe(200)
    expect(response.contentType).toContain(MEDIA_TYPE)
    expect(response.body.data).toMatchObject({ type: "articles", id: "1", attributes: { title: "Hello" } })
  })

  it("honours an explicit `status` alongside the overridden success schema", async () => {
    const AcceptedApi = HttpApi.make("accepted-blog").add(
      Group.make(Article, Endpoint.delete(Article, { success: Tombstone, status: 202 }))
    )
    const AcceptedLive = HttpApiBuilder.group(AcceptedApi, "articles", (handlers) =>
      handlers.handle("delete", () => Effect.succeed({ data: sampleArticle }))
    )
    const response = await request(AcceptedApi, AcceptedLive, "http://localhost/articles/1")
    expect(response.status).toBe(202)
    expect(response.body.data).toMatchObject({ type: "articles", id: "1" })
  })

  it("types the overridden success as the supplied schema, and the default as void", () => {
    const tombstone = Endpoint.delete(Article, { success: Tombstone })
    expectTypeOf<HttpApiEndpoint.Success<typeof tombstone>["Type"]>().toEqualTypeOf<typeof Tombstone.Type>()

    const noContent = Endpoint.delete(Article)
    expectTypeOf<HttpApiEndpoint.Success<typeof noContent>["Type"]>().toEqualTypeOf<void>()
  })

  it("changes only the success — name, method, path and middleware are untouched", () => {
    const tombstone = Endpoint.delete(Article, { success: Tombstone })
    expect([tombstone.identifier, tombstone.method, tombstone.path]).toEqual([
      deleteArticle.identifier,
      deleteArticle.method,
      deleteArticle.path
    ])
    expect([...tombstone.middlewares].map((m) => m.key)).toEqual([...deleteArticle.middlewares].map((m) => m.key))
  })

  it("threads through Endpoint.resource's per-endpoint delete config", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, {
        relationships: false,
        endpoints: { delete: { success: Tombstone } }
      }).map((endpoint) => [endpoint.identifier, endpoint])
    )
    expect(HttpApiSchema.isNoContent([...byName.delete!.success][0]!.ast)).toBe(false)
  })

  it("leaves Endpoint.resource's delete at 204 when no override is given (regression)", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, { relationships: false }).map((endpoint) => [endpoint.identifier, endpoint])
    )
    expect(HttpApiSchema.isNoContent([...byName.delete!.success][0]!.ast)).toBe(true)
  })

  it("threads through Group.resource, typed end to end", () => {
    const group = Group.resource(Article, {
      relationships: false,
      endpoints: { get: false, list: false, create: false, update: false, delete: { success: Tombstone } }
    })
    expectTypeOf<HttpApiEndpoint.Success<typeof group.endpoints.delete>["Type"]>().toEqualTypeOf<
      typeof Tombstone.Type
    >()
  })
})

// ---------------------------------------------------------------------------
// Query override (Endpoint.list)
// ---------------------------------------------------------------------------

describe("Endpoint.list query override", () => {
  // A flat list contract: the page cursor is bracketed on the wire but decoded
  // flat, alongside an entity filter and a flag JSON:API has no family for.
  const FlatListQuery = Query.bracketPageKeys(
    Schema.Struct({
      ...Query.Page.offset({ maxLimit: 100 }),
      sort: Schema.optionalKey(Schema.String),
      authorId: Schema.optionalKey(Schema.String),
      includeDeleted: Schema.optionalKey(Schema.Literals(["true", "false"]))
    })
  )

  const queryOf = (endpoint: { readonly query?: Schema.Top | undefined }) => endpoint.query as Schema.Codec<any, any>

  it("composes the query from the feature options when none is given (regression: unchanged default)", () => {
    const endpoint = Endpoint.list(Article, {
      include: true,
      sort: true,
      page: Query.Page.Offset,
      filter: { author: Schema.optionalKey(Schema.String) }
    })
    // …decoding the spec's bracket families into the nested shape, as before
    // this option existed.
    expect(
      Schema.decodeUnknownSync(queryOf(endpoint))({
        include: "author",
        sort: "-createdAt",
        "page[offset]": "20",
        "page[limit]": "10",
        "filter[author]": "9"
      })
    ).toEqual({
      include: ["author"],
      sort: [{ field: "createdAt", direction: "desc" }],
      page: { offset: 20, limit: 10 },
      filter: { author: "9" }
    })
  })

  it("replaces the whole composition when `query` is supplied", () => {
    const endpoint = Endpoint.list(Article, { query: FlatListQuery })
    expect(
      Schema.decodeUnknownSync(queryOf(endpoint))({
        "page[offset]": "20",
        "page[limit]": "10",
        sort: "-createdAt",
        authorId: "9",
        includeDeleted: "true"
      })
      // decoded flat — no `page` / `filter` nesting, and `includeDeleted`
      // never becomes `filter[includeDeleted]`
    ).toEqual({ offset: 20, limit: 10, sort: "-createdAt", authorId: "9", includeDeleted: "true" })
  })

  it("ignores the feature options once `query` is supplied", () => {
    const endpoint = Endpoint.list(Article, {
      include: true,
      page: Query.Page.Offset,
      filter: { author: Schema.optionalKey(Schema.String) },
      query: FlatListQuery
    })
    // the package-composed families are gone: `filter[author]` is now excess
    expect(() =>
      Schema.decodeUnknownSync(queryOf(endpoint))({ "filter[author]": "9" }, { onExcessProperty: "error" })
    ).toThrow()
  })

  it("changes only the query — name, method, path, success and middleware are untouched", () => {
    const flat = Endpoint.list(Article, { query: FlatListQuery })
    const composed = Endpoint.list(Article)
    expect([flat.identifier, flat.method, flat.path]).toEqual([composed.identifier, composed.method, composed.path])
    expect([...flat.middlewares].map((m) => m.key)).toEqual([...composed.middlewares].map((m) => m.key))
  })

  it("types the overridden query as the supplied schema", () => {
    const flat = Endpoint.list(Article, { query: FlatListQuery })
    expectTypeOf<HttpApiEndpoint.Query<typeof flat>["Type"]>().toEqualTypeOf<typeof FlatListQuery.Type>()

    const composed = Endpoint.list(Article, { page: Query.Page.Offset })
    expectTypeOf<HttpApiEndpoint.Query<typeof composed>["Type"]>().toEqualTypeOf<{
      readonly page?: { readonly offset?: number; readonly limit?: number }
    }>()
  })

  it("threads through Endpoint.resource's per-endpoint list config", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, {
        relationships: false,
        endpoints: { list: { query: FlatListQuery } }
      }).map((endpoint) => [endpoint.identifier, endpoint])
    )
    expect(Schema.decodeUnknownSync(queryOf(byName.list!))({ "page[limit]": "10", authorId: "9" })).toEqual({
      limit: 10,
      authorId: "9"
    })
  })

  it("leaves Endpoint.resource's list query package-composed when no override is given (regression)", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, { relationships: false, page: Query.Page.Offset }).map((endpoint) => [
        endpoint.identifier,
        endpoint
      ])
    )
    expect(Schema.decodeUnknownSync(queryOf(byName.list!))({ "page[limit]": "10", include: "author" })).toEqual({
      page: { limit: 10 },
      include: ["author"]
    })
  })

  it("threads through Group.resource, typed end to end", () => {
    const group = Group.resource(Article, {
      relationships: false,
      endpoints: { get: false, create: false, update: false, delete: false, list: { query: FlatListQuery } }
    })
    expectTypeOf<HttpApiEndpoint.Query<typeof group.endpoints.list>["Type"]>().toEqualTypeOf<
      typeof FlatListQuery.Type
    >()
  })
})

describe("HTTP round-trip with an overridden list query", () => {
  const FlatListQuery = Query.bracketPageKeys(
    Schema.Struct({
      ...Query.Page.offset({ maxLimit: 100 }),
      authorId: Schema.optionalKey(Schema.String)
    })
  )

  const FlatApi = HttpApi.make("flat-list-blog").add(
    Group.make(Article, Endpoint.list(Article, { query: FlatListQuery, meta: Schema.Struct({ total: Schema.Int }) }))
  )

  const FlatLive = HttpApiBuilder.group(FlatApi, "articles", (handlers) =>
    handlers.handle("list", ({ query }) =>
      Effect.succeed({
        // the handler consumes the flat struct directly — no `query.page`
        data: query.authorId === "9" ? [sampleArticle].slice(0, query.limit ?? 1) : [],
        meta: { total: query.offset ?? 0 }
      })
    )
  )

  it("decodes the bracketed page cursor flat and serves a JSON:API collection", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(FlatApi, ["articles"])
        return yield* client.articles.list({ query: { offset: 3, limit: 1, authorId: "9" } })
      }).pipe(Effect.scoped, Effect.provide(FlatLive), Effect.provide(Middleware.layer)) as Effect.Effect<any>
    )

    expect(result.data).toHaveLength(1)
    expect(result.data[0]).toMatchObject({ type: "articles", id: "1" })
    expect(result.meta).toEqual({ total: 3 })
  })
})

// ---------------------------------------------------------------------------
// Constrained include paths (Endpoint.get / Endpoint.list)
// ---------------------------------------------------------------------------

describe("Endpoint include path constraints", () => {
  const queryOf = (endpoint: { readonly query?: Schema.Top | undefined }) => endpoint.query as Schema.Codec<any, any>

  it("advertises the whole graph at depth 2 when `include: true` (regression: the default)", () => {
    const endpoint = Endpoint.get(Article, { include: true })
    expect(Schema.decodeUnknownSync(queryOf(endpoint))({ include: "author,comments,comments.author" })).toEqual({
      include: ["author", "comments", "comments.author"]
    })
  })

  it("narrows `get` to an explicit allow-list", () => {
    const endpoint = Endpoint.get(Article, { include: { paths: ["author"] } })
    expect(Schema.decodeUnknownSync(queryOf(endpoint))({ include: "author" })).toEqual({ include: ["author"] })
    // the depth-2 path the resolver can't populate is a 400 now, not a 200
    // carrying an empty `included`
    expect(() => Schema.decodeUnknownSync(queryOf(endpoint))({ include: "comments.author" })).toThrow()
    expectTypeOf<HttpApiEndpoint.Query<typeof endpoint>["Type"]>().toEqualTypeOf<{
      readonly include?: ReadonlyArray<"author">
    }>()
  })

  it("narrows `list` by depth", () => {
    const endpoint = Endpoint.list(Article, { include: { depth: 1 } })
    expect(Schema.decodeUnknownSync(queryOf(endpoint))({ include: "author,comments" })).toEqual({
      include: ["author", "comments"]
    })
    expect(() => Schema.decodeUnknownSync(queryOf(endpoint))({ include: "comments.author" })).toThrow()
    expectTypeOf<HttpApiEndpoint.Query<typeof endpoint>["Type"]>().toEqualTypeOf<{
      readonly include?: ReadonlyArray<"author" | "comments">
    }>()
  })

  it("threads through Endpoint.resource, per endpoint and top level", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, {
        include: { depth: 1 },
        endpoints: { get: { include: { paths: ["author"] } } }
      }).map((endpoint) => [endpoint.identifier, endpoint])
    )

    // the per-endpoint allow-list wins on `get`
    expect(() => Schema.decodeUnknownSync(queryOf(byName.get!))({ include: "comments" })).toThrow()
    // `list` inherits the top-level depth bound
    expect(Schema.decodeUnknownSync(queryOf(byName.list!))({ include: "comments" })).toEqual({ include: ["comments"] })
    expect(() => Schema.decodeUnknownSync(queryOf(byName.list!))({ include: "comments.author" })).toThrow()
    // a relationship endpoint's paths are its *target's* graph, so it only
    // inherits that `include` is on
    expect(Schema.decodeUnknownSync(queryOf(byName.comments!))({ include: "author" })).toEqual({
      include: ["author"]
    })
  })

  it("leaves Endpoint.resource advertising the full depth-2 graph by default (regression)", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, { relationships: false }).map((endpoint) => [endpoint.identifier, endpoint])
    )
    expect(Schema.decodeUnknownSync(queryOf(byName.list!))({ include: "comments.author" })).toEqual({
      include: ["comments.author"]
    })
  })

  it("threads through Group.resource, typed end to end", () => {
    const group = Group.resource(Article, {
      relationships: false,
      include: { paths: ["author"] },
      endpoints: { create: false, update: false, delete: false }
    })
    expectTypeOf<HttpApiEndpoint.Query<typeof group.endpoints.get>["Type"]>().toEqualTypeOf<{
      readonly include?: ReadonlyArray<"author">
      readonly fields?: {
        readonly articles?: ReadonlyArray<"title" | "body" | "createdAt">
        readonly people?: ReadonlyArray<"firstName" | "lastName">
        readonly comments?: ReadonlyArray<"body">
      }
    }>()
  })
})

// ---------------------------------------------------------------------------
// Success document override (Endpoint.get / list / create / update)
// ---------------------------------------------------------------------------

// Reads the success schema off a constructed endpoint.
const successSchemaOf = (endpoint: { readonly success: Iterable<unknown> }) =>
  [...endpoint.success][0]! as Schema.Codec<any, any>

describe("primary-data success override", () => {
  // The wire variant of the resource: identical but for its link members, which
  // are plain strings. A resource's own `links.self` is `Document.Link`, so it
  // decodes an absolute reference to a `URL` — the right model of the spec, and
  // the wrong type for an api whose assembler stringifies every link before the
  // document leaves the server, and whose generated client consumes strings.
  const WireArticle = Schema.Struct({
    ...Article.fields,
    links: Schema.optionalKey(Schema.Struct({ self: Schema.optionalKey(Schema.String) }))
  })
  const WireDocument = Document.DataDocument(WireArticle)
  const WireCollection = Document.CollectionDocument(WireArticle)

  // Today's defaults, which the option must leave undisturbed.
  const StandardDocument = Article.document()
  const StandardCollection = Article.collection()

  const wireArticle = {
    type: "articles",
    id: "1",
    attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" },
    links: { self: "https://api.example.com/articles/1" }
  }

  it("decodes `links.self` as a URL by default (regression: unchanged without `success`)", () => {
    const decoded = Schema.decodeUnknownSync(successSchemaOf(fetchArticle))({ data: wireArticle })
    expect(decoded.data.links.self).toBeInstanceOf(URL)
  })

  it("decodes `links.self` as a plain string when `success` is the wire variant", () => {
    const wire = Endpoint.get(Article, { success: WireDocument })
    const decoded = Schema.decodeUnknownSync(successSchemaOf(wire))({ data: wireArticle })
    expect(decoded.data.links.self).toBe("https://api.example.com/articles/1")
    expect(decoded.data.links.self).not.toBeInstanceOf(URL)
  })

  it("types the overridden success as the supplied schema, and the default as the resource document", () => {
    const wire = Endpoint.get(Article, { success: WireDocument })
    expectTypeOf<HttpApiEndpoint.Success<typeof wire>["Type"]>().toEqualTypeOf<typeof WireDocument.Type>()

    const standard = Endpoint.get(Article)
    expectTypeOf<HttpApiEndpoint.Success<typeof standard>["Type"]>().toEqualTypeOf<typeof StandardDocument.Type>()
  })

  it("types list's overridden success as the supplied collection, and the default as the resource collection", () => {
    const wire = Endpoint.list(Article, { success: WireCollection })
    expectTypeOf<HttpApiEndpoint.Success<typeof wire>["Type"]>().toEqualTypeOf<typeof WireCollection.Type>()

    const standard = Endpoint.list(Article)
    expectTypeOf<HttpApiEndpoint.Success<typeof standard>["Type"]>().toEqualTypeOf<typeof StandardCollection.Type>()
  })

  it("types create's and update's overridden success, leaving their payloads alone", () => {
    const created = Endpoint.create(Article, { success: WireDocument })
    expectTypeOf<HttpApiEndpoint.Success<typeof created>["Type"]>().toEqualTypeOf<typeof WireDocument.Type>()
    expectTypeOf<HttpApiEndpoint.Payload<typeof created>["Type"]>().toEqualTypeOf<typeof Article.createPayload.Type>()

    // …and the two overrides compose: a flat command input in, a wire document out
    const flat = Endpoint.update(Article, { payload: Article.updateInput, success: WireDocument })
    expectTypeOf<HttpApiEndpoint.Success<typeof flat>["Type"]>().toEqualTypeOf<typeof WireDocument.Type>()
    expectTypeOf<HttpApiEndpoint.Payload<typeof flat>["Type"]>().toEqualTypeOf<typeof Article.updateInput.Type>()
  })

  it("changes only the success — name, method, path and middleware are untouched", () => {
    const wire = Endpoint.list(Article, { success: WireCollection })
    const standard = Endpoint.list(Article)
    expect([wire.identifier, wire.method, wire.path]).toEqual([standard.identifier, standard.method, standard.path])
    expect([...wire.middlewares].map((m) => m.key)).toEqual([...standard.middlewares].map((m) => m.key))
  })

  it("threads through Endpoint.resource's per-endpoint get/list/create/update config", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, {
        relationships: false,
        endpoints: {
          get: { success: WireDocument },
          list: { success: WireCollection },
          create: { success: WireDocument },
          update: { success: WireDocument }
        }
      }).map((endpoint) => [endpoint.identifier, endpoint])
    )

    for (const name of ["get", "create", "update"]) {
      const decoded = Schema.decodeUnknownSync(successSchemaOf(byName[name]!))({ data: wireArticle })
      expect(decoded.data.links.self).toBe("https://api.example.com/articles/1")
    }
    const listed = Schema.decodeUnknownSync(successSchemaOf(byName.list!))({ data: [wireArticle] })
    expect(listed.data[0].links.self).toBe("https://api.example.com/articles/1")
  })

  it("leaves Endpoint.resource's documents at the resource's own when no override is given (regression)", () => {
    const byName = Object.fromEntries(
      Endpoint.resource(Article, { relationships: false }).map((endpoint) => [endpoint.identifier, endpoint])
    )

    for (const name of ["get", "create", "update"]) {
      const decoded = Schema.decodeUnknownSync(successSchemaOf(byName[name]!))({ data: wireArticle })
      expect(decoded.data.links.self).toBeInstanceOf(URL)
    }
    const listed = Schema.decodeUnknownSync(successSchemaOf(byName.list!))({ data: [wireArticle] })
    expect(listed.data[0].links.self).toBeInstanceOf(URL)
  })

  it("threads through Group.resource, typed end to end", () => {
    const group = Group.resource(Article, {
      relationships: false,
      endpoints: {
        get: { success: WireDocument },
        list: { success: WireCollection },
        create: false,
        update: false,
        delete: false
      }
    })
    expectTypeOf<HttpApiEndpoint.Success<typeof group.endpoints.get>["Type"]>().toEqualTypeOf<
      typeof WireDocument.Type
    >()
    expectTypeOf<HttpApiEndpoint.Success<typeof group.endpoints.list>["Type"]>().toEqualTypeOf<
      typeof WireCollection.Type
    >()
  })
})

describe("HTTP round-trip with a wire success document", () => {
  const WireArticle = Schema.Struct({
    ...Article.fields,
    links: Schema.optionalKey(Schema.Struct({ self: Schema.optionalKey(Schema.String) }))
  })
  const WireDocument = Document.DataDocument(WireArticle)
  const WireCollection = Document.CollectionDocument(WireArticle, {
    meta: Schema.Struct({ total: Schema.Int })
  })

  const WireApi = HttpApi.make("wire-blog").add(
    Group.make(
      Article,
      Endpoint.get(Article, { success: WireDocument, errors: [ArticleNotFound] }),
      Endpoint.list(Article, { page: Query.Page.Offset, success: WireCollection }),
      Endpoint.create(Article, { success: WireDocument })
    )
  )

  // The assembler: every link stringified before the document leaves the server.
  const assemble = (article: typeof Article.Type) => ({
    ...article,
    links: { self: `https://api.example.com/articles/${article.id}` }
  })

  const WireLive = HttpApiBuilder.group(WireApi, "articles", (handlers) =>
    handlers
      .handle("get", ({ params }) => loadArticle(params.id).pipe(Effect.map((a) => ({ data: assemble(a) }))))
      .handle("list", ({ query }) =>
        Effect.succeed({
          data: [assemble(sampleArticle)],
          meta: { total: 1 },
          // the document envelope is untouched, so the pagination helpers still apply
          links: Handlers.offsetPaginationLinks("/articles", query.page ?? {}, 1)
        })
      )
      .handle("create", () => Effect.succeed({ data: assemble(sampleArticle) }))
  )

  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
      effect.pipe(Effect.scoped, Effect.provide(WireLive), Effect.provide(Middleware.layer)) as Effect.Effect<
        A,
        E,
        never
      >
    )

  it("answers `get` with the wire document — links.self is a string on the client", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(WireApi, ["articles"])
        return yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} })
      })
    )

    expect(result.data).toMatchObject({ type: "articles", id: "1" })
    expect(result.data.links?.self).toBe("https://api.example.com/articles/1")
    expectTypeOf(result.data.links?.self).toEqualTypeOf<string | undefined>()
  })

  it("answers `list` with the wire collection, pagination links included", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(WireApi, ["articles"])
        return yield* client.articles.list({ query: { page: { offset: 0, limit: 10 } } })
      })
    )

    expect(result.data[0]!.links?.self).toBe("https://api.example.com/articles/1")
    expect(result.meta).toEqual({ total: 1 })
    expect(result.links?.first).toBe("/articles?page[offset]=0&page[limit]=10")
    expect(result.links?.next).toBeNull()
  })

  it("answers `create` with the wire document, still at 201", async () => {
    const result = await run(
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(WireApi, ["articles"])
        return yield* client.articles.create({
          payload: {
            data: {
              type: "articles",
              attributes: { title: "Hello", body: "World", createdAt: new Date("2024-01-01T00:00:00.000Z") }
            }
          }
        })
      })
    )

    expect(result.data.links?.self).toBe("https://api.example.com/articles/1")
  })
})

// ---------------------------------------------------------------------------
// Write status override (Endpoint.create / Endpoint.update)
// ---------------------------------------------------------------------------

describe("Endpoint.create / Endpoint.update status override", () => {
  // A status is invisible in the decoded schema, so the assertions are on the
  // wire — what a real web handler actually answers.
  const request = async (
    api: unknown,
    live: Layer.Layer<any, any, any>,
    method: string,
    url: string,
    body: unknown
  ) => {
    const appLayer = HttpApiBuilder.layer(api as never).pipe(
      Layer.provide(live),
      Layer.provide(Middleware.layer)
    ) as unknown as Layer.Layer<never, never, HttpRouter.HttpRouter>
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer)
    try {
      const response = await handler(
        new Request(url, { method, headers: { "content-type": MEDIA_TYPE }, body: JSON.stringify(body) })
      )
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: (await response.json()) as any
      }
    } finally {
      await dispose()
    }
  }

  const createBody = {
    data: {
      type: "articles",
      attributes: { title: "Hello", body: "World", createdAt: "2024-01-01T00:00:00.000Z" }
    }
  }
  const updateBody = { data: { type: "articles", id: "1", attributes: { title: "Hello" } } }

  // Every case below is the same two endpoints, differing only in the options
  // under test; the handlers answer the resource document regardless.
  const writesApi = (name: string, ...endpoints: readonly [any, ...ReadonlyArray<any>]) =>
    HttpApi.make(name).add(Group.make(Article, ...endpoints))

  const writesLive = (api: any): Layer.Layer<any, any, any> =>
    HttpApiBuilder.group(api, "articles", (handlers: any) =>
      handlers
        .handle("create", () => Effect.succeed({ data: sampleArticle }))
        .handle("update", () => Effect.succeed({ data: sampleArticle }))
    ) as Layer.Layer<any, any, any>

  const roundTrip = async (createOptions?: any, updateOptions?: any) => {
    const api = writesApi(
      `writes-${JSON.stringify(createOptions ?? {})}-${JSON.stringify(updateOptions ?? {})}`,
      Endpoint.create(Article, createOptions),
      Endpoint.update(Article, updateOptions)
    )
    const live = writesLive(api)
    return {
      created: await request(api, live, "POST", "http://localhost/articles", createBody),
      updated: await request(api, live, "PATCH", "http://localhost/articles/1", updateBody)
    }
  }

  it("answers 201 on create and 200 on update when no status is given (regression: unchanged defaults)", async () => {
    const { created, updated } = await roundTrip()
    expect(created.status).toBe(201)
    expect(updated.status).toBe(200)
    expect(created.body.data).toMatchObject({ type: "articles", id: "1" })
  })

  it("keeps those defaults when only `success` is overridden (regression)", async () => {
    const WireDocument = Document.DataDocument(
      Schema.Struct({
        ...Article.fields,
        links: Schema.optionalKey(Schema.Struct({ self: Schema.optionalKey(Schema.String) }))
      })
    )
    const { created, updated } = await roundTrip({ success: WireDocument }, { success: WireDocument })
    expect(created.status).toBe(201)
    expect(updated.status).toBe(200)
  })

  it("answers with the supplied status instead, document and media type intact", async () => {
    const { created, updated } = await roundTrip({ status: 200 }, { status: 202 })
    expect(created.status).toBe(200)
    expect(created.contentType).toContain(MEDIA_TYPE)
    expect(created.body.data).toMatchObject({ type: "articles", id: "1" })
    expect(updated.status).toBe(202)
    expect(updated.body.data).toMatchObject({ type: "articles", id: "1" })
  })

  it("applies the status to an overridden success schema too", async () => {
    const WireDocument = Document.DataDocument(
      Schema.Struct({
        ...Article.fields,
        links: Schema.optionalKey(Schema.Struct({ self: Schema.optionalKey(Schema.String) }))
      })
    )
    const { created } = await roundTrip({ success: WireDocument, status: 200 })
    expect(created.status).toBe(200)
  })

  it("changes only the status — name, method, path, payload and middleware are untouched", () => {
    const ok = Endpoint.create(Article, { status: 200 })
    expect([ok.identifier, ok.method, ok.path]).toEqual([
      createArticle.identifier,
      createArticle.method,
      createArticle.path
    ])
    expect([...ok.middlewares].map((m) => m.key)).toEqual([...createArticle.middlewares].map((m) => m.key))
    expectTypeOf<HttpApiEndpoint.Payload<typeof ok>["Type"]>().toEqualTypeOf<typeof Article.createPayload.Type>()
  })

  it("threads through Endpoint.resource / Group.resource's per-endpoint create/update config", async () => {
    const api = HttpApi.make("generated-ok-writes").add(
      Group.resource(Article, {
        relationships: false,
        endpoints: { get: false, list: false, delete: false, create: { status: 200 }, update: { status: 202 } }
      })
    )
    const live = writesLive(api)
    expect((await request(api, live, "POST", "http://localhost/articles", createBody)).status).toBe(200)
    expect((await request(api, live, "PATCH", "http://localhost/articles/1", updateBody)).status).toBe(202)
  })

  it("leaves Endpoint.resource's create at 201 and update at 200 when no override is given (regression)", async () => {
    const api = HttpApi.make("generated-default-writes").add(
      Group.resource(Article, {
        relationships: false,
        endpoints: { get: false, list: false, delete: false }
      })
    )
    const live = writesLive(api)
    expect((await request(api, live, "POST", "http://localhost/articles", createBody)).status).toBe(201)
    expect((await request(api, live, "PATCH", "http://localhost/articles/1", updateBody)).status).toBe(200)
  })
})
