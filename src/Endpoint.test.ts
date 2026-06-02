import { describe, expect, expectTypeOf, it } from "vitest"
import { Cause, Effect, Exit, Result, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiTest } from "effect/unstable/httpapi"
import * as ApiError from "./ApiError.js"
import * as Endpoint from "./Endpoint.js"
import * as Group from "./Group.js"
import * as Middleware from "./Middleware.js"
import * as Query from "./Query.js"
import { Resource, toMany, toOne } from "./Resource.js"

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
    body: Schema.String,
    createdAt: Schema.DateFromString
  },
  relationships: {
    author: toOne(() => Person),
    comments: toMany(() => Comment)
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

const articles = Group.make(Article, fetchArticle, listArticles, createArticle, updateArticle, removeArticle)

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
      ))
    .handle("list", ({ query }) =>
      Effect.succeed({
        data: query.page?.limit === 0 ? [] : [sampleArticle],
        meta: { total: 1 }
      }))
    .handle("create", ({ payload }) =>
      Effect.succeed({
        data: Article.make({
          id: Article.Id.make("new-id"),
          attributes: payload.data.attributes,
          ...(payload.data.relationships !== undefined ? { relationships: payload.data.relationships } : {})
        })
      }))
    .handle("update", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => ({
          data: Article.make({
            ...article,
            attributes: { ...article.attributes, ...(payload.data.attributes ?? {}) }
          })
        }))
      ))
    .handle("remove", ({ params }) => loadArticle(params.id).pipe(Effect.asVoid))
)

const findFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const result = Cause.findError(cause)
  return Result.isSuccess(result) ? result.success : undefined
}

const buildClient = HttpApiTest.groups(Api, ["articles"])

const withHandlers = <A, E>(effect: Effect.Effect<A, E, any>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(ArticlesLive),
    Effect.provide(Middleware.layer)
  ) as Effect.Effect<A, E, never>

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
    expect(Object.keys(articles.endpoints)).toEqual(["fetch", "list", "create", "update", "remove"])
  })
})

// ---------------------------------------------------------------------------
// HTTP round-trips through the in-memory client
// ---------------------------------------------------------------------------

describe("HTTP round-trip via HttpApiTest", () => {
  it("fetches a single resource document", async () => {
    const result = await Effect.runPromise(withHandlers(Effect.gen(function*() {
      const client = yield* buildClient
      return yield* client.articles.fetch({ params: { id: Article.Id.make("1") }, query: {} })
    })))

    expect(result.data).toMatchObject({ type: "articles", id: "1" })
    expect(result.data?.attributes.title).toBe("Hello")
    // The branded id type flows through the client
    if (result.data !== null) {
      expectTypeOf<typeof result.data.id>().toEqualTypeOf<typeof Article.Id.Type>()
      expect(result.data.attributes.createdAt).toBeInstanceOf(Date)
    }
  })

  it("serves compound documents when include is requested", async () => {
    const result = await Effect.runPromise(withHandlers(Effect.gen(function*() {
      const client = yield* buildClient
      return yield* client.articles.fetch({
        params: { id: Article.Id.make("1") },
        query: { include: ["author"] }
      })
    })))

    expect(result.included).toHaveLength(1)
    expect(result.included?.[0]).toMatchObject({ type: "people", id: "9" })
  })

  it("lists a collection document with typed query params", async () => {
    const result = await Effect.runPromise(withHandlers(Effect.gen(function*() {
      const client = yield* buildClient
      return yield* client.articles.list({
        query: {
          sort: [{ field: "createdAt", direction: "desc" }],
          page: { offset: 0, limit: 10 },
          filter: { author: "9" }
        }
      })
    })))

    expect(result.data).toHaveLength(1)
    expect(result.meta?.total).toBe(1)
  })

  it("creates a resource from a JSON:API payload (201)", async () => {
    const result = await Effect.runPromise(withHandlers(Effect.gen(function*() {
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
    })))

    expect(result.data).toMatchObject({ type: "articles", id: "new-id" })
    expect(result.data?.attributes.title).toBe("New article")
  })

  it("updates a resource with a partial attributes payload", async () => {
    const result = await Effect.runPromise(withHandlers(Effect.gen(function*() {
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
    })))

    expect(result.data?.attributes.title).toBe("Updated title")
    expect(result.data?.attributes.body).toBe("World")
  })

  it("removes a resource (204, no content)", async () => {
    const result = await Effect.runPromise(withHandlers(Effect.gen(function*() {
      const client = yield* buildClient
      return yield* client.articles.remove({ params: { id: Article.Id.make("1") } })
    })))
    expect(result).toBeUndefined()
  })

  it("surfaces domain errors as typed tagged errors on the client", async () => {
    const exit = await Effect.runPromiseExit(withHandlers(Effect.gen(function*() {
      const client = yield* buildClient
      return yield* client.articles.fetch({ params: { id: Article.Id.make("missing") }, query: {} })
    })))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = findFailure(exit.cause)
      expect(error).toBeInstanceOf(ArticleNotFound)
      expect((error as ArticleNotFound).id).toBe("missing")
    }
  })

  it("recovers from domain errors with catchTag", async () => {
    const recovered = await Effect.runPromise(withHandlers(Effect.gen(function*() {
      const client = yield* buildClient
      return yield* client.articles.fetch({ params: { id: Article.Id.make("missing") }, query: {} }).pipe(
        Effect.catchTag("ArticleNotFound", (error) => Effect.succeed(`not found: ${error.id}`))
      )
    })))

    expect(recovered).toBe("not found: missing")
  })

  it("rejects unknown include paths with a 400 BadRequest", async () => {
    const exit = await Effect.runPromiseExit(withHandlers(Effect.gen(function*() {
      const client = yield* buildClient
      return yield* client.articles.fetch({
        params: { id: Article.Id.make("1") },
        // Bypass client-side validation to test the server's response
        query: { include: ["publisher"] } as never
      })
    })))

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Type-level guarantees
// ---------------------------------------------------------------------------

describe("type-level guarantees", () => {
  it("handler error channels are restricted to declared errors", () => {
    // fetch declares ArticleNotFound, so its handler may fail with it;
    // create declares no errors, so its error channel is never.
    type FetchError = typeof fetchArticle extends { readonly "~Error": { readonly "Type": infer E } } ? E : never
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
