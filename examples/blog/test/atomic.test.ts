/**
 * End-to-end test of the blog example's atomic operations endpoint
 * (https://jsonapi.org/ext/atomic/): real HTTP round-trips through the
 * in-memory `HttpApiTest` client, exercising multi-operation requests,
 * lid-based references, relationship operations (including on `paginated`
 * relationships) and all-or-nothing semantics.
 */
import { describe, expect, expectTypeOf, it } from "vitest"
import { Cause, Effect, Exit, Result, Schema } from "effect"
import { HttpApiTest, OpenApi } from "effect/unstable/httpapi"
import { ApiError, Atomic, Middleware } from "@thomasfosterau/effect-jsonapi"
import { Api } from "../api.js"
import { OperationFailed } from "../errors.js"
import { ArticlesLive, OperationsLive, sampleArticle, sampleAuthor, sampleComments, sampleTag } from "../handlers.js"
import { Article, Comment, Person, Tag } from "../resources.js"

const buildClient = HttpApiTest.groups(Api, ["articles", "operations"])

const middleware = Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })

const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(ArticlesLive),
      Effect.provide(OperationsLive),
      Effect.provide(middleware)
    ) as Effect.Effect<A, E, never>
  )

const runExit = <A, E>(effect: Effect.Effect<A, E, any>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.scoped,
      Effect.provide(ArticlesLive),
      Effect.provide(OperationsLive),
      Effect.provide(middleware)
    ) as Effect.Effect<A, E, never>
  )

const findFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const result = Cause.findError(cause)
  return Result.isSuccess(result) ? result.success : undefined
}

describe("atomic operations: creating with lids", () => {
  it("creates an article and a comment linked to it by lid, atomically", async () => {
    const { document, linkage } = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        const document = yield* client.operations.operations({
          payload: Atomic.request(
            // 1. create an article — it has no id yet, so it declares a lid.
            //    `author` is a required (`one`) relationship.
            Atomic.add(Article, {
              lid: "a1",
              attributes: {
                title: "Atomic bikeshedding",
                body: "Both or neither.",
                createdAt: new Date("2024-06-01T00:00:00.000Z")
              },
              relationships: {
                author: { data: Person.ref(sampleAuthor.id) },
                tags: { data: [Tag.ref(sampleTag.id)] }
              }
            }),
            // 2. create a comment on it
            Atomic.add(Comment, {
              lid: "c1",
              attributes: { body: "Witty remark" },
              relationships: { author: { data: Person.ref(sampleAuthor.id) } }
            }),
            // 3. link the comment into the article's paginated comments
            //    relationship — both sides referenced by lid
            Atomic.addToRelationship(Article, { lid: "a1" }, "comments", [Comment.lidRef("c1")])
          )
        })

        // the paginated comments relationship is only reachable through its
        // relationship endpoint — verify the linkage landed there
        const articleId = document["atomic:results"][0]!.data!.id
        const linkage = yield* client.articles.commentsRelationship({
          params: { id: Article.Id.make(articleId) },
          query: {}
        })
        return { document, linkage }
      })
    )

    const results = document["atomic:results"]
    expect(results).toHaveLength(3)

    // results arrive in operation order; relationship operations return no data
    const article = results[0]?.data
    const comment = results[1]?.data
    expect(article?.type).toBe("articles")
    expect(comment?.type).toBe("comments")
    expect(results[2]?.data).toBeUndefined()

    if (article?.type === "articles" && comment?.type === "comments") {
      expect(article.attributes.createdAt).toBeInstanceOf(Date)
      // the data union is discriminated by `type`
      expectTypeOf(article.attributes.title).toEqualTypeOf<string>()
      expectTypeOf(comment.attributes.body).toEqualTypeOf<string>()
      // the lid-based linkage was resolved to the comment's real id
      expect(linkage.data.map((ref) => ref.id)).toEqual([comment.id])
    }
  })

  it("the created resources are visible through the regular endpoints", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        const client = yield* buildClient

        const created = yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Article, {
              attributes: {
                title: "Fetch me later",
                body: "",
                createdAt: new Date("2024-06-02T00:00:00.000Z")
              },
              relationships: {
                author: { data: Person.ref(sampleAuthor.id) }
              }
            })
          )
        })

        const id = created["atomic:results"][0]!.data!.id
        return yield* client.articles.fetch({ params: { id: Article.Id.make(id) }, query: {} })
      })
    )

    expect(fetched.data?.attributes.title).toBe("Fetch me later")
  })
})

describe("atomic operations: updating and removing", () => {
  it("updates and removes resources in one request", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient

        // create a comment to remove (so the sample data stays intact)
        const created = yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Comment, {
              attributes: { body: "Doomed" },
              relationships: { author: { data: Person.ref(sampleAuthor.id) } }
            })
          )
        })
        const doomedId = created["atomic:results"][0]!.data!.id

        return yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.update(Article, {
              id: sampleArticle.id,
              attributes: { title: "Atomically retitled" }
            }),
            Atomic.remove(Comment, doomedId)
          )
        })
      })
    )

    const results = document["atomic:results"]
    expect(results).toHaveLength(2)
    // updates return the updated resource; removals return no data
    expect(results[0]?.data?.attributes).toMatchObject({ title: "Atomically retitled" })
    expect(results[1]?.data).toBeUndefined()
  })

  it("removes a resource created earlier in the same request, by lid", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Comment, {
              lid: "ephemeral",
              attributes: { body: "Now you see me" },
              relationships: { author: { data: Person.ref(sampleAuthor.id) } }
            }),
            Atomic.remove(Comment, { lid: "ephemeral" })
          )
        })
      })
    )

    expect(document["atomic:results"]).toHaveLength(2)
    expect(document["atomic:results"][1]?.data).toBeUndefined()
  })
})

describe("atomic operations: relationship operations", () => {
  it("replaces a required (`one`) to-one relationship", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient

        // create a second person to point the comment's author at
        const comment = sampleComments[0]!
        return yield* client.operations.operations({
          payload: Atomic.request(
            // `one` relationships are replaced with another identifier — never null
            Atomic.updateRelationship(Comment, comment.id, "author", Person.ref(sampleAuthor.id))
          )
        })
      })
    )

    // relationship operations return no data
    expect(document["atomic:results"]).toEqual([{}])
  })

  it("replaces an article's tags (`many`, inline linkage)", async () => {
    const { after, document } = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        const document = yield* client.operations.operations({
          payload: Atomic.request(Atomic.updateRelationship(Article, sampleArticle.id, "tags", []))
        })
        const after = yield* client.articles.fetch({
          params: { id: sampleArticle.id },
          query: {}
        })
        // restore the original tag for other tests
        yield* client.operations.operations({
          payload: Atomic.request(Atomic.updateRelationship(Article, sampleArticle.id, "tags", [Tag.ref(sampleTag.id)]))
        })
        return { after, document }
      })
    )

    expect(document["atomic:results"]).toEqual([{}])
    expect(after.data?.relationships?.tags.data).toEqual([])
  })

  it("adds to and removes from a `paginated` relationship", async () => {
    const { added, removed } = await run(
      Effect.gen(function* () {
        const client = yield* buildClient

        // create a standalone comment, then link it to the article's comments
        const created = yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Comment, {
              lid: "linked",
              attributes: { body: "Link me" },
              relationships: { author: { data: Person.ref(sampleAuthor.id) } }
            }),
            Atomic.addToRelationship(Article, sampleArticle.id, "comments", [Comment.lidRef("linked")])
          )
        })

        const commentId = created["atomic:results"][0]!.data!.id
        const afterAdd = yield* client.articles.commentsRelationship({
          params: { id: sampleArticle.id },
          query: {}
        })

        // now unlink it again
        yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.removeFromRelationship(Article, sampleArticle.id, "comments", [Comment.ref(commentId)])
          )
        })
        const afterRemove = yield* client.articles.commentsRelationship({
          params: { id: sampleArticle.id },
          query: {}
        })

        return {
          added: afterAdd.data.map((ref) => ref.id),
          removed: afterRemove.data.map((ref) => ref.id)
        }
      })
    )

    expect(added.length).toBe(removed.length + 1)
  })
})

describe("atomic operations: all-or-nothing", () => {
  it("a failing operation rolls back every earlier operation", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.operations.operations({
          payload: Atomic.request(
            // this one would succeed...
            Atomic.add(Article, {
              attributes: { title: "Never persisted", body: "", createdAt: new Date() },
              relationships: { author: { data: Person.ref(sampleAuthor.id) } }
            }),
            // ...but this one fails (unknown article), so nothing is applied
            Atomic.update(Article, {
              id: Article.Id.make("does-not-exist"),
              attributes: { title: "Nope" }
            })
          )
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = findFailure(exit.cause)
      expect(error).toBeInstanceOf(OperationFailed)
      // the error identifies the operation that failed
      expect((error as OperationFailed).operation).toBe(1)
    }

    // the first operation's article was not committed
    const list = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.articles.list({ query: {} })
      })
    )
    expect(list.data.map((article) => article.attributes.title)).not.toContain("Never persisted")
  })

  it("referencing an unknown lid fails the whole request", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Article, {
              attributes: { title: "Refers to nothing", body: "", createdAt: new Date() },
              relationships: {
                author: { data: Person.lidRef("never-declared") }
              }
            })
          )
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = findFailure(exit.cause)
      expect(error).toBeInstanceOf(OperationFailed)
      expect((error as OperationFailed).reason).toMatch(/never-declared/)
      expect((error as OperationFailed).operation).toBe(0)
    }
  })
})

describe("atomic operations: the wire format", () => {
  it("error documents point at the failing operation", () => {
    const encoded = Schema.encodeUnknownSync(OperationFailed.wire)(
      new OperationFailed({ operation: 1, reason: "article not found" })
    ) as typeof ApiError.WireDocument.Type
    expect(encoded.errors[0]?.detail).toBe("Operation at /atomic:operations/1 failed: article not found")
    expect(encoded.errors[0]?.status).toBe("422")
    expect(encoded.errors[0]?.meta).toEqual({ operation: 1, reason: "article not found" })
  })

  it("OpenAPI documents the operations endpoint with the extension media type", () => {
    const spec = OpenApi.fromApi(Api)
    expect(spec.paths["/operations"]?.post).toBeDefined()
    const json = JSON.stringify(spec.paths["/operations"])
    expect(json).toContain("atomic")
  })

  it("content negotiation accepts the extension media type only when configured", () => {
    expect(Middleware.contentTypeIsAcceptable(Atomic.MEDIA_TYPE, { extensions: [Atomic.EXTENSION_URI] })).toBe(true)
    expect(Middleware.contentTypeIsAcceptable(Atomic.MEDIA_TYPE)).toBe(false)
  })
})
