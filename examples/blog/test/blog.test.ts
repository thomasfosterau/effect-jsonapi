/**
 * End-to-end test of the blog example: a real HTTP round-trip (request
 * encoding → routing → middleware → handler → response decoding) through the
 * in-memory `HttpApiTest` client.
 */
import { describe, expect, expectTypeOf, it } from "vitest"
import { Cause, Effect, Exit, Result, Schema } from "effect"
import { HttpApiTest, OpenApi } from "effect/unstable/httpapi"
import { Atomic, Client, Middleware, Resource } from "@thomasfosterau/effect-jsonapi"
import { Api } from "../api.js"
import { ArticleNotFound, TitleTaken } from "../errors.js"
import { ArticlesLive, sampleArticle, sampleAuthor, sampleComments, SearchLive } from "../handlers.js"
import { Article, Comment, Person } from "../resources.js"

const buildClient = HttpApiTest.groups(Api, ["articles", "search"])

const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(ArticlesLive),
      Effect.provide(SearchLive),
      Effect.provide(Middleware.layer)
    ) as Effect.Effect<A, E, never>
  )

const runExit = <A, E>(effect: Effect.Effect<A, E, any>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.scoped,
      Effect.provide(ArticlesLive),
      Effect.provide(SearchLive),
      Effect.provide(Middleware.layer)
    ) as Effect.Effect<A, E, never>
  )

const findFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const result = Cause.findError(cause)
  return Result.isSuccess(result) ? result.success : undefined
}

describe("blog example: fetching", () => {
  it("fetches a single article document with a self link", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.fetch({
          params: { id: Article.Id.make("1") },
          query: {}
        })
      })
    )

    expect(document.data).toMatchObject({
      type: "articles",
      id: "1",
      attributes: { title: "JSON:API paints my bikeshed!" }
    })
    expect(document.links?.self).toBe("/articles/1")
    // dates decode through the wire format
    expect(document.data?.attributes.createdAt).toBeInstanceOf(Date)
  })

  it("serves compound documents for ?include=author,tags", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.fetch({
          params: { id: Article.Id.make("1") },
          query: { include: ["author", "tags"] }
        })
      })
    )

    const types = document.included?.map((resource) => resource.type).sort()
    expect(types).toEqual(["people", "tags"])
  })

  it("paginated relationships appear as links, never as inline data or includes", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.fetch({
          params: { id: Article.Id.make("1") },
          query: {}
        })
      })
    )

    // The comments relationship carries only links pointing at its endpoints.
    const comments = document.data?.relationships?.comments
    expect(comments).toEqual({
      links: {
        self: "/articles/1/relationships/comments",
        related: "/articles/1/comments"
      }
    })
    // ... and `comments` is not a legal include path.
    type IncludePaths = Resource.IncludePath<typeof Article>
    expectTypeOf<IncludePaths>().toEqualTypeOf<"author" | "tags">()
  })

  it("narrows `included` to the requested include paths on the client", async () => {
    const include = ["author"] as const
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles
          .fetch({
            params: { id: Article.Id.make("1") },
            query: { include }
          })
          .pipe(Client.narrowIncluded(Article, include))
      })
    )

    // Runtime: the server only included the requested author
    expect(document.included?.map((resource) => resource.type)).toEqual(["people"])
    // Types: `included` is narrowed to Person — its attributes are accessible
    // without discriminating on `type`
    const author = document.included?.[0]
    expect(author?.attributes.firstName).toBe("Dan")
    expectTypeOf(author!.attributes.firstName).toEqualTypeOf<string>()
    expectTypeOf(author!.type).toEqualTypeOf<"people">()
  })

  it("404s with a typed error for unknown articles", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.fetch({
          params: { id: Article.Id.make("nope") },
          query: {}
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = findFailure(exit.cause)
      expect(error).toBeInstanceOf(ArticleNotFound)
      expect((error as ArticleNotFound).id).toBe("nope")
    }
  })
})

describe("blog example: listing", () => {
  it("lists articles with sorting, pagination and typed meta", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.list({
          query: {
            sort: [{ field: "createdAt", direction: "desc" }],
            page: { offset: 0, limit: 10 }
          }
        })
      })
    )

    expect(document.data.length).toBeGreaterThan(0)
    expect(document.meta?.total).toBeGreaterThan(0)
    expect(document.links?.first).toBe("/articles?page[offset]=0&page[limit]=10")
  })

  it("filters by author", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.list({
          query: { filter: { author: "does-not-exist" } }
        })
      })
    )

    expect(document.data).toEqual([])
  })
})

describe("blog example: writing", () => {
  it("creates an article from a JSON:API payload (201) and then deletes it (204)", async () => {
    await run(
      Effect.gen(function* () {
        const client = yield* buildClient

        const created = yield* client.articles.create({
          payload: {
            data: {
              type: "articles",
              lid: "temp-1",
              attributes: {
                title: "A fresh take",
                body: "...",
                createdAt: new Date("2024-06-01T00:00:00.000Z")
              },
              relationships: {
                // `author` is a required (`one`) relationship — the payload
                // doesn't compile (or decode) without it.
                author: { data: Person.ref(sampleAuthor.id) }
              }
            }
          }
        })

        expect(created.data).not.toBeNull()
        expect(created.data?.attributes.title).toBe("A fresh take")
        expect(created.data?.relationships?.author.data.id).toBe(sampleAuthor.id)
        // The paginated comments relationship is created empty, links only.
        expect(created.data?.relationships?.comments.links.related).toBe(`/articles/${created.data!.id}/comments`)

        // and delete it again
        yield* client.articles.delete({ params: { id: created.data!.id } })
      })
    )
  })

  it("409s when the title is already taken", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.create({
          payload: {
            data: {
              type: "articles",
              attributes: {
                title: sampleArticle.attributes.title,
                body: "duplicate",
                createdAt: new Date()
              },
              relationships: {
                author: { data: Person.ref(sampleAuthor.id) }
              }
            }
          }
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(findFailure(exit.cause)).toBeInstanceOf(TitleTaken)
    }
  })

  it("updates an article with partial attributes", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.update({
          params: { id: Article.Id.make("1") },
          payload: {
            data: {
              type: "articles",
              id: Article.Id.make("1"),
              attributes: { body: "Updated body" }
            }
          }
        })
      })
    )

    expect(document.data?.attributes.body).toBe("Updated body")
    expect(document.data?.attributes.title).toBe(sampleArticle.attributes.title)
  })
})

describe("blog example: related resource endpoints", () => {
  it("GET /articles/:id/author serves the author as a full resource document", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.author({
          params: { id: Article.Id.make("1") },
          query: {}
        })
      })
    )

    expect(document.data).toMatchObject({
      type: "people",
      id: sampleAuthor.id,
      attributes: { firstName: "Dan", lastName: "Gebhardt" }
    })
    expect(document.links?.self).toBe("/articles/1/author")
  })

  it("GET /articles/:id/comments serves the paginated comment collection", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.comments({
          params: { id: Article.Id.make("1") },
          query: { page: { offset: 0, limit: 1 } }
        })
      })
    )

    // Full comment resources, paginated
    expect(document.data).toHaveLength(1)
    expect(document.data[0]?.attributes.body).toBe("First!")
    expect(document.meta?.total).toBe(2)
    expect(document.links?.next).toBe("/articles/1/comments?page[offset]=1&page[limit]=1")
  })

  it("GET /articles/:id/comments supports compound documents (?include=author)", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.comments({
          params: { id: Article.Id.make("1") },
          query: { include: ["author"] }
        })
      })
    )

    expect(document.data).toHaveLength(2)
    // Both comments share the same author — deduplicated to one include.
    expect(document.included?.map((resource) => resource.type)).toEqual(["people"])
  })

  it("404s for related endpoints of unknown articles", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.comments({
          params: { id: Article.Id.make("nope") },
          query: {}
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(findFailure(exit.cause)).toBeInstanceOf(ArticleNotFound)
    }
  })
})

describe("blog example: relationship endpoints", () => {
  it("GET /articles/:id/relationships/comments serves paginated linkage", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.commentsRelationship({
          params: { id: Article.Id.make("1") },
          query: {}
        })
      })
    )

    // Identifiers only — no attributes
    expect(document.data).toEqual(sampleComments.map((comment) => ({ type: "comments", id: comment.id })))
    expect(document.links?.self).toBe("/articles/1/relationships/comments")
    expect(document.links?.related).toBe("/articles/1/comments")
    expect(document.meta?.total).toBe(2)
  })

  it("PATCH /articles/:id/relationships/author replaces the author", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        const replaced = yield* client.articles.updateAuthorRelationship({
          params: { id: Article.Id.make("1") },
          payload: { data: Person.ref(sampleAuthor.id) }
        })
        // The article reflects the change
        const article = yield* client.articles.fetch({
          params: { id: Article.Id.make("1") },
          query: {}
        })
        expect(article.data?.relationships?.author.data.id).toBe(sampleAuthor.id)
        return replaced
      })
    )

    expect(document.data).toEqual({ type: "people", id: sampleAuthor.id })
  })

  it("POST /articles/:id/relationships/comments attaches comments; DELETE detaches them", async () => {
    await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        const articleId = Article.Id.make("1")

        // Detach one comment
        yield* client.articles.removeCommentsRelationship({
          params: { id: articleId },
          payload: { data: [Comment.ref(sampleComments[0]!.id)] }
        })

        const afterRemove = yield* client.articles.commentsRelationship({
          params: { id: articleId },
          query: {}
        })
        expect(afterRemove.data.map((identifier) => identifier.id)).toEqual([sampleComments[1]!.id])

        // Re-attach it
        const afterAdd = yield* client.articles.addCommentsRelationship({
          params: { id: articleId },
          payload: { data: [Comment.ref(sampleComments[0]!.id)] }
        })
        expect(afterAdd.data.map((identifier) => identifier.id).sort()).toEqual(
          sampleComments.map((comment) => comment.id).sort()
        )
      })
    )
  })

  it("documents relationship endpoints in OpenAPI", () => {
    const spec = OpenApi.fromApi(Api)
    // Related resource endpoints
    expect(spec.paths["/articles/{id}/author"]?.get).toBeDefined()
    expect(spec.paths["/articles/{id}/comments"]?.get).toBeDefined()
    // Relationship (linkage) endpoints
    expect(spec.paths["/articles/{id}/relationships/comments"]?.get).toBeDefined()
    expect(spec.paths["/articles/{id}/relationships/comments"]?.post).toBeDefined()
    expect(spec.paths["/articles/{id}/relationships/comments"]?.delete).toBeDefined()
    expect(spec.paths["/articles/{id}/relationships/author"]?.patch).toBeDefined()
    // The related comment collection documents its pagination parameters
    const commentParams = spec.paths["/articles/{id}/comments"]?.get?.parameters?.map(
      (parameter: any) => parameter.name
    )
    expect(commentParams).toContain("page[offset]")
    expect(commentParams).toContain("page[limit]")
    expect(commentParams).toContain("include")
  })
})

describe("blog example: heterogeneous search", () => {
  it("returns a mixed collection of articles and people, discriminated by type", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        // "an" matches both "...paints my bikeshed!" (article body "...Ever.") — no.
        // Use a term hitting both stores: "d" → "bikeshed"/"Dan"/"Gebhardt"
        return yield* client.search.search({
          query: { filter: { q: "d" } }
        })
      })
    )

    const types = [...new Set(document.data.map((result) => result.type))].sort()
    expect(types).toEqual(["articles", "people"])

    // the union is discriminated by the `type` tag
    for (const result of document.data) {
      if (result.type === "articles") {
        expectTypeOf(result.attributes.title).toEqualTypeOf<string>()
        expect(typeof result.attributes.title).toBe("string")
      } else {
        expectTypeOf(result.attributes.firstName).toEqualTypeOf<string>()
        expect(typeof result.attributes.firstName).toBe("string")
      }
    }
  })

  it("filters across both resource types", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.search.search({
          query: { filter: { q: "bikeshed" } }
        })
      })
    )

    // only the article matches "bikeshed"
    expect(document.data.map((result) => result.type)).toEqual(["articles"])
    expect(document.meta?.total).toBe(1)
  })

  it("paginates heterogeneous results with links", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.search.search({
          query: { filter: { q: "" }, page: { offset: 0, limit: 1 } }
        })
      })
    )

    expect(document.data).toHaveLength(1)
    expect(document.meta?.total).toBeGreaterThan(1)
    expect(document.links?.next).toBe("/search?page[offset]=1&page[limit]=1")
  })

  it("supports include across the searched resources' graphs", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.search.search({
          query: { filter: { q: "bikeshed" }, include: ["author"] }
        })
      })
    )

    // the matched article's author is included
    expect(document.included?.map((resource) => resource.type)).toEqual(["people"])
  })

  it("documents the search endpoint in OpenAPI", () => {
    const spec = OpenApi.fromApi(Api)
    expect(spec.paths["/search"]?.get).toBeDefined()
    const params = spec.paths["/search"]?.get?.parameters?.map((parameter: any) => parameter.name)
    expect(params).toContain("filter[q]")
    expect(params).toContain("fields[articles]")
    expect(params).toContain("fields[people]")
    expect(params).toContain("page[offset]")
  })
})

describe("blog example: spec compliance on the wire", () => {
  it("error documents are spec-compliant JSON:API", () => {
    const wire = Schema.encodeUnknownSync(ArticleNotFound.wire)(new ArticleNotFound({ id: "42" }))
    expect(wire).toEqual({
      errors: [
        {
          status: "404",
          code: "not_found",
          title: "Resource not found",
          detail: "Article 42 not found",
          meta: { id: "42" }
        }
      ]
    })
  })

  it("content negotiation predicates implement JSON:API §5", () => {
    // JSON:API content type with parameters other than ext / profile → 415
    expect(Middleware.contentTypeIsAcceptable("application/vnd.api+json; charset=utf-8")).toBe(false)
    expect(Middleware.contentTypeIsAcceptable("application/vnd.api+json")).toBe(true)
    // profile parameters are never rejected; ext parameters require support
    expect(Middleware.contentTypeIsAcceptable('application/vnd.api+json;profile="x"')).toBe(true)
    expect(Middleware.contentTypeIsAcceptable(Atomic.MEDIA_TYPE)).toBe(false)
    expect(
      Middleware.contentTypeIsAcceptable(Atomic.MEDIA_TYPE, {
        extensions: [Atomic.EXTENSION_URI]
      })
    ).toBe(true)
    // Accept in which every JSON:API instance has non-ext/profile parameters → 406
    expect(Middleware.acceptIsAcceptable("application/vnd.api+json;q=0.9")).toBe(false)
    expect(Middleware.acceptIsAcceptable("application/vnd.api+json")).toBe(true)
    expect(Middleware.acceptIsAcceptable("*/*")).toBe(true)
  })

  it("OpenAPI generation reflects the JSON:API media type and statuses", () => {
    const spec = OpenApi.fromApi(Api)
    const json = JSON.stringify(spec)
    expect(json).toContain("application/vnd.api+json")
    // create → 201, remove → 204, fetch errors → 404
    expect(spec.paths["/articles"]?.post?.responses).toHaveProperty("201")
    expect(spec.paths["/articles/{id}"]?.delete?.responses).toHaveProperty("204")
    expect(spec.paths["/articles/{id}"]?.get?.responses).toHaveProperty("404")
    // typed query parameters are documented
    const listParams = spec.paths["/articles"]?.get?.parameters?.map((parameter: any) => parameter.name)
    expect(listParams).toContain("sort")
    expect(listParams).toContain("page[offset]")
    expect(listParams).toContain("filter[author]")
  })

  it("sample resources decode against their own schemas (round-trip)", () => {
    const encoded = Schema.encodeUnknownSync(Article)(sampleArticle)
    expect(encoded.attributes.createdAt).toBe("2024-01-01T00:00:00.000Z")
    const decoded = Schema.decodeUnknownSync(Article)(encoded)
    expect(decoded).toEqual(sampleArticle)

    const person = Schema.encodeUnknownSync(Person)(sampleAuthor)
    expect(person.attributes.twitter).toBe("dgeb")
  })
})
