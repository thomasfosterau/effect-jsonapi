import { describe, expect, expectTypeOf, it } from "vitest"
import { Cause, Effect, Exit, Result, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiTest } from "effect/unstable/httpapi"
import * as ApiError from "./ApiError.js"
import * as Endpoint from "./Endpoint.js"
import * as Group from "./Group.js"
import * as Handlers from "./Handlers.js"
import * as Middleware from "./Middleware.js"
import * as Query from "./Query.js"
import * as Relationship from "./Relationship.js"
import { make as Resource } from "./Resource.js"

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

const fetchArticle = Endpoint.fetch(Article, {
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

const removeArticle = Endpoint.remove(Article, { errors: [ArticleNotFound] })

// Relationship & related endpoints
const relatedAuthor = Endpoint.related(Article, "author", { errors: [ArticleNotFound] })

const relatedComments = Endpoint.related(Article, "comments", {
  page: Query.Page.Offset,
  errors: [ArticleNotFound]
})

const fetchCommentsRelationship = Endpoint.fetchRelationship(Article, "comments", { errors: [ArticleNotFound] })

const updateAuthorRelationship = Endpoint.updateRelationship(Article, "author", { errors: [ArticleNotFound] })

const addCommentsRelationship = Endpoint.addRelationship(Article, "comments", { errors: [ArticleNotFound] })

const removeCommentsRelationship = Endpoint.removeRelationship(Article, "comments", { errors: [ArticleNotFound] })

const articles = Group.make(
  Article,
  fetchArticle,
  listArticles,
  createArticle,
  updateArticle,
  removeArticle,
  relatedAuthor,
  relatedComments,
  fetchCommentsRelationship,
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
    .handle("fetch", ({ params, query }) =>
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
    .handle("remove", ({ params }) => loadArticle(params.id).pipe(Effect.asVoid))
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
    expect(fetchArticle.name).toBe("fetch")
    expect(fetchArticle.method).toBe("GET")
    expect(fetchArticle.path).toBe("/articles/:id")

    expect(listArticles.name).toBe("list")
    expect(listArticles.method).toBe("GET")
    expect(listArticles.path).toBe("/articles")

    expect(createArticle.name).toBe("create")
    expect(createArticle.method).toBe("POST")
    expect(createArticle.path).toBe("/articles")

    expect(updateArticle.name).toBe("update")
    expect(updateArticle.method).toBe("PATCH")
    expect(updateArticle.path).toBe("/articles/:id")

    expect(removeArticle.name).toBe("remove")
    expect(removeArticle.method).toBe("DELETE")
    expect(removeArticle.path).toBe("/articles/:id")
  })

  it("allows overriding name and path", () => {
    const search = Endpoint.list(Article, { name: "search", path: "/articles/search" })
    expect(search.name).toBe("search")
    expect(search.path).toBe("/articles/search")
  })

  it("attaches the JSON:API protocol middlewares to every endpoint", () => {
    for (const endpoint of [fetchArticle, listArticles, createArticle, updateArticle, removeArticle]) {
      const middlewareIds = [...endpoint.middlewares].map((m) => m.key)
      expect(middlewareIds).toContain("effect-jsonapi/ContentNegotiation")
      expect(middlewareIds).toContain("effect-jsonapi/SchemaErrors")
    }
  })

  it("groups take the resource type as their identifier", () => {
    expect(articles.identifier).toBe("articles")
    expect(Object.keys(articles.endpoints)).toEqual([
      "fetch",
      "list",
      "create",
      "update",
      "remove",
      "author",
      "comments",
      "commentsRelationship",
      "updateAuthorRelationship",
      "addCommentsRelationship",
      "removeCommentsRelationship"
    ])
  })

  it("groups can be named directly for heterogeneous endpoints", () => {
    const group = Group.make("search", Endpoint.search([Article, Person]))
    expect(group.identifier).toBe("search")
    expect(Object.keys(group.endpoints)).toEqual(["search"])
  })
})

// ---------------------------------------------------------------------------
// Heterogeneous (search) endpoints
// ---------------------------------------------------------------------------

describe("Endpoint.search", () => {
  const searchEndpoint = Endpoint.search([Article, Person], {
    include: true,
    fields: true,
    filter: { q: Schema.String },
    page: Query.Page.Offset,
    meta: Schema.Struct({ total: Schema.Int })
  })

  it("uses conventional name/path with GET", () => {
    expect(searchEndpoint.name).toBe("search")
    expect(searchEndpoint.method).toBe("GET")
    expect(searchEndpoint.path).toBe("/search")
  })

  it("allows overriding name and path (e.g. for feeds)", () => {
    const feed = Endpoint.search([Article, Comment], { name: "feed", path: "/feed" })
    expect(feed.name).toBe("feed")
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
    expect(relatedAuthor.name).toBe("author")
    expect(relatedAuthor.method).toBe("GET")
    expect(relatedAuthor.path).toBe("/articles/:id/author")

    expect(relatedComments.name).toBe("comments")
    expect(relatedComments.method).toBe("GET")
    expect(relatedComments.path).toBe("/articles/:id/comments")
  })

  it("relationship endpoints derive conventional names, methods and paths", () => {
    expect(fetchCommentsRelationship.name).toBe("commentsRelationship")
    expect(fetchCommentsRelationship.method).toBe("GET")
    expect(fetchCommentsRelationship.path).toBe("/articles/:id/relationships/comments")

    expect(updateAuthorRelationship.name).toBe("updateAuthorRelationship")
    expect(updateAuthorRelationship.method).toBe("PATCH")
    expect(updateAuthorRelationship.path).toBe("/articles/:id/relationships/author")

    expect(addCommentsRelationship.name).toBe("addCommentsRelationship")
    expect(addCommentsRelationship.method).toBe("POST")
    expect(addCommentsRelationship.path).toBe("/articles/:id/relationships/comments")

    expect(removeCommentsRelationship.name).toBe("removeCommentsRelationship")
    expect(removeCommentsRelationship.method).toBe("DELETE")
    expect(removeCommentsRelationship.path).toBe("/articles/:id/relationships/comments")
  })

  it("allows overriding name and path", () => {
    const custom = Endpoint.related(Article, "author", {
      name: "articleAuthor",
      path: "/articles/:id/writer"
    })
    expect(custom.name).toBe("articleAuthor")
    expect(custom.path).toBe("/articles/:id/writer")
  })

  it("attaches the JSON:API protocol middlewares", () => {
    for (const endpoint of [
      relatedAuthor,
      relatedComments,
      fetchCommentsRelationship,
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
      Endpoint.fetchRelationship(Article, "publisher")
    ).toThrow(/Unknown relationship "publisher"/)
  })

  it("paginated relationships get related collection endpoints", () => {
    const catalog = Endpoint.related(Publisher, "catalog", { page: Query.Page.Offset })
    expect(catalog.name).toBe("catalog")
    expect(catalog.method).toBe("GET")
    expect(catalog.path).toBe("/publishers/:id/catalog")

    // ... and their linkage endpoint pages through identifiers.
    const catalogLinkage = Endpoint.fetchRelationship(Publisher, "catalog", { page: Query.Page.Offset })
    expect(catalogLinkage.path).toBe("/publishers/:id/relationships/catalog")
  })
})

describe("relationship endpoint schemas", () => {
  it("fetchRelationship success is a linkage document (identifiers, not resources)", () => {
    const successSchema = [...fetchCommentsRelationship.success][0]!
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
    expect(operationsEndpoint.name).toBe("operations")
    expect(operationsEndpoint.method).toBe("POST")
    expect(operationsEndpoint.path).toBe("/operations")
  })

  it("allows overriding name and path", () => {
    const bulk = Endpoint.operations([Article], { name: "bulk", path: "/bulk" })
    expect(bulk.name).toBe("bulk")
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
          return yield* client.articles.fetch({ params: { id: Article.Id.make("1") }, query: {} })
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
          return yield* client.articles.fetch({
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

  it("removes a resource (204, no content)", async () => {
    const result = await Effect.runPromise(
      withHandlers(
        Effect.gen(function* () {
          const client = yield* buildClient
          return yield* client.articles.remove({ params: { id: Article.Id.make("1") } })
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
          return yield* client.articles.fetch({ params: { id: Article.Id.make("missing") }, query: {} })
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
            .fetch({ params: { id: Article.Id.make("missing") }, query: {} })
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
          return yield* client.articles.fetch({
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
    // create/update/remove have no query parameters
    expect(createArticle.query).toBeUndefined()
    expect(updateArticle.query).toBeUndefined()
    expect(removeArticle.query).toBeUndefined()
  })
})
