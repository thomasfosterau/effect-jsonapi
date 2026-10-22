/**
 * End-to-end test of the blog example's atomic operations endpoint
 * (https://jsonapi.org/ext/atomic/): real HTTP round-trips through the
 * in-memory `HttpApiTest` client, exercising multi-operation requests,
 * lid-based references, relationship operations (including on `paginated`
 * relationships) and all-or-nothing semantics.
 */
import { assert, describe, expect, expectTypeOf, it } from "vite-plus/test";
import { Cause, Effect, Exit, Result, Schema } from "effect";
import { HttpApiTest, OpenApi } from "effect/http-api";
import { ApiError, Atomic, Middleware } from "@thomasfosterau/effect-jsonapi";
import { Api } from "../api.js";
import { CommentNotFound, OperationFailed, PersonNotFound, TagNotFound } from "../errors.js";
import {
  ArticlesLive,
  OperationsLive,
  sampleArticle,
  sampleAuthor,
  sampleComments,
  sampleTag,
} from "../handlers.js";
import { Article, Comment, Person, Tag } from "../resources.js";

const buildClient = HttpApiTest.groups(Api, ["articles", "operations"]);

const middleware = Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] });

const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(ArticlesLive),
      Effect.provide(OperationsLive),
      Effect.provide(middleware),
    ) as Effect.Effect<A, E, never>,
  );

const runExit = <A, E>(effect: Effect.Effect<A, E, any>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.scoped,
      Effect.provide(ArticlesLive),
      Effect.provide(OperationsLive),
      Effect.provide(middleware),
    ) as Effect.Effect<A, E, never>,
  );

const findFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const result = Cause.findError(cause);
  return Result.isSuccess(result) ? result.success : undefined;
};

describe("atomic operations: creating with lids", () => {
  it("creates an article and a comment linked to it by lid, atomically", async () => {
    const { document, linkage } = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;
        const document = yield* client.operations.operations({
          payload: Atomic.request(
            // 1. create an article — it has no id yet, so it declares a lid.
            //    `author` is a required (`one`) relationship.
            Atomic.add(Article, {
              lid: "a1",
              attributes: {
                title: "Atomic bikeshedding",
                body: "Both or neither.",
                createdAt: new Date("2024-06-01T00:00:00.000Z"),
              },
              relationships: {
                author: { data: Person.ref(sampleAuthor.id) },
                tags: { data: [Tag.ref(sampleTag.id)] },
              },
            }),
            // 2. create a comment on it
            Atomic.add(Comment, {
              lid: "c1",
              attributes: { body: "Witty remark" },
              relationships: { author: { data: Person.ref(sampleAuthor.id) } },
            }),
            // 3. link the comment into the article's paginated comments
            //    relationship — both sides referenced by lid
            Atomic.addToRelationship(Article, { lid: "a1" }, "comments", [Comment.lidRef("c1")]),
          ),
        });

        // the paginated comments relationship is only reachable through its
        // relationship endpoint — verify the linkage landed there
        const articleId = document["atomic:results"][0]!.data!.id;
        const linkage = yield* client.articles.commentsRelationship({
          params: { id: Article.Id.make(articleId) },
          query: {},
        });
        return { document, linkage };
      }),
    );

    const results = document["atomic:results"];
    expect(results).toHaveLength(3);

    // results arrive in operation order; relationship operations return no data
    const article = results[0]?.data;
    const comment = results[1]?.data;
    expect(article?.type).toBe("articles");
    expect(comment?.type).toBe("comments");
    expect(results[2]?.data).toBeUndefined();

    assert(article?.type === "articles");
    assert(comment?.type === "comments");
    expect(article.attributes.createdAt).toBeInstanceOf(Date);
    // the data union is discriminated by `type`
    expectTypeOf(article.attributes.title).toEqualTypeOf<string>();
    expectTypeOf(comment.attributes.body).toEqualTypeOf<string>();
    // the lid-based linkage was resolved to the comment's real id
    expect(linkage.data.map((ref) => ref.id)).toEqual([comment.id]);
  });

  it("the created resources are visible through the regular endpoints", async () => {
    const fetched = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;

        const created = yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Article, {
              attributes: {
                title: "Fetch me later",
                body: "",
                createdAt: new Date("2024-06-02T00:00:00.000Z"),
              },
              relationships: {
                author: { data: Person.ref(sampleAuthor.id) },
              },
            }),
          ),
        });

        const id = created["atomic:results"][0]!.data!.id;
        return yield* client.articles.get({ params: { id: Article.Id.make(id) }, query: {} });
      }),
    );

    expect(fetched.data?.attributes.title).toBe("Fetch me later");
  });
});

describe("atomic operations: updating and removing", () => {
  it("updates and removes resources in one request", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;

        // create a comment to remove (so the sample data stays intact)
        const created = yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Comment, {
              attributes: { body: "Doomed" },
              relationships: { author: { data: Person.ref(sampleAuthor.id) } },
            }),
          ),
        });
        const doomedId = created["atomic:results"][0]!.data!.id;

        return yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.update(Article, {
              id: sampleArticle.id,
              attributes: { title: "Atomically retitled" },
            }),
            Atomic.remove(Comment, doomedId),
          ),
        });
      }),
    );

    const results = document["atomic:results"];
    expect(results).toHaveLength(2);
    // updates return the updated resource; removals return no data
    expect(results[0]?.data?.attributes).toMatchObject({ title: "Atomically retitled" });
    expect(results[1]?.data).toBeUndefined();
  });

  it("removes a resource created earlier in the same request, by lid", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;
        return yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Comment, {
              lid: "ephemeral",
              attributes: { body: "Now you see me" },
              relationships: { author: { data: Person.ref(sampleAuthor.id) } },
            }),
            Atomic.remove(Comment, { lid: "ephemeral" }),
          ),
        });
      }),
    );

    expect(document["atomic:results"]).toHaveLength(2);
    expect(document["atomic:results"][1]?.data).toBeUndefined();
  });
});

describe("atomic operations: relationship operations", () => {
  it("replaces a required (`one`) to-one relationship", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;

        // create a second person to point the comment's author at
        const comment = sampleComments[0]!;
        return yield* client.operations.operations({
          payload: Atomic.request(
            // `one` relationships are replaced with another identifier — never null
            Atomic.updateRelationship(Comment, comment.id, "author", Person.ref(sampleAuthor.id)),
          ),
        });
      }),
    );

    // relationship operations return no data
    expect(document["atomic:results"]).toEqual([{}]);
  });

  it("replaces an article's tags (`many`, inline linkage)", async () => {
    const { after, document } = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;
        const document = yield* client.operations.operations({
          payload: Atomic.request(Atomic.updateRelationship(Article, sampleArticle.id, "tags", [])),
        });
        const after = yield* client.articles.get({
          params: { id: sampleArticle.id },
          query: {},
        });
        // restore the original tag for other tests
        yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.updateRelationship(Article, sampleArticle.id, "tags", [Tag.ref(sampleTag.id)]),
          ),
        });
        return { after, document };
      }),
    );

    expect(document["atomic:results"]).toEqual([{}]);
    expect(after.data?.relationships?.tags.data).toEqual([]);
  });

  it("adds to and removes from a `paginated` relationship", async () => {
    const { added, removed } = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;

        // create a standalone comment, then link it to the article's comments
        const created = yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Comment, {
              lid: "linked",
              attributes: { body: "Link me" },
              relationships: { author: { data: Person.ref(sampleAuthor.id) } },
            }),
            Atomic.addToRelationship(Article, sampleArticle.id, "comments", [
              Comment.lidRef("linked"),
            ]),
          ),
        });

        const commentId = created["atomic:results"][0]!.data!.id;
        const afterAdd = yield* client.articles.commentsRelationship({
          params: { id: sampleArticle.id },
          query: {},
        });

        // now unlink it again
        yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.removeFromRelationship(Article, sampleArticle.id, "comments", [
              Comment.ref(commentId),
            ]),
          ),
        });
        const afterRemove = yield* client.articles.commentsRelationship({
          params: { id: sampleArticle.id },
          query: {},
        });

        return {
          added: afterAdd.data.map((ref) => ref.id),
          removed: afterRemove.data.map((ref) => ref.id),
        };
      }),
    );

    expect(added.length).toBe(removed.length + 1);
  });
});

describe("atomic operations: all-or-nothing", () => {
  it("a failing operation rolls back every earlier operation", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient;
        return yield* client.operations.operations({
          payload: Atomic.request(
            // this one would succeed...
            Atomic.add(Article, {
              attributes: { title: "Never persisted", body: "", createdAt: new Date() },
              relationships: { author: { data: Person.ref(sampleAuthor.id) } },
            }),
            // ...but this one fails (unknown article), so nothing is applied
            Atomic.update(Article, {
              id: Article.Id.make("does-not-exist"),
              attributes: { title: "Nope" },
            }),
          ),
        });
      }),
    );

    assert(Exit.isFailure(exit));
    const error = findFailure(exit.cause);
    expect(error).toBeInstanceOf(OperationFailed);
    // the error identifies the operation that failed
    expect((error as OperationFailed).operation).toBe(1);

    // the first operation's article was not committed
    const list = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;
        return yield* client.articles.list({ query: {} });
      }),
    );
    expect(list.data.map((article) => article.attributes.title)).not.toContain("Never persisted");
  });

  it("referencing an unknown lid fails the whole request", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient;
        return yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Article, {
              attributes: { title: "Refers to nothing", body: "", createdAt: new Date() },
              relationships: {
                author: { data: Person.lidRef("never-declared") },
              },
            }),
          ),
        });
      }),
    );

    assert(Exit.isFailure(exit));
    const error = findFailure(exit.cause);
    expect(error).toBeInstanceOf(OperationFailed);
    expect((error as OperationFailed).reason).toMatch(/never-declared/);
    expect((error as OperationFailed).operation).toBe(0);
  });
});

describe("atomic operations: linkage to an absent resource", () => {
  it("an author op naming an unknown person 404s and rolls back the whole request", async () => {
    const { exit, articles, author } = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;
        const exit = yield* Effect.exit(
          client.operations.operations({
            payload: Atomic.request(
              // this one would succeed...
              Atomic.add(Article, {
                attributes: {
                  title: "Orphaned by a 404",
                  body: "",
                  createdAt: sampleArticle.attributes.createdAt,
                },
                relationships: { author: { data: Person.ref(sampleAuthor.id) } },
              }),
              // ...but this one names a person the store does not hold
              Atomic.updateRelationship(
                Article,
                sampleArticle.id,
                "author",
                Person.ref("does-not-exist"),
              ),
            ),
          }),
        );
        const list = yield* client.articles.list({ query: {} });
        const after = yield* client.articles.get({ params: { id: sampleArticle.id }, query: {} });
        return {
          exit,
          articles: list.data.map((article) => article.attributes.title),
          author: after.data?.relationships?.author.data.id,
        };
      }),
    );

    assert(Exit.isFailure(exit));
    const error = findFailure(exit.cause);
    assert(error instanceof PersonNotFound);
    expect(error.id).toBe("does-not-exist");
    // the pointer locates the linkage inside the failing operation
    expect(error.pointer).toBe("/atomic:operations/1/data");
    // all-or-nothing: neither operation was committed
    expect(articles).not.toContain("Orphaned by a 404");
    expect(author).toBe(sampleAuthor.id);
  });

  it("a resource op linking an unknown author 404s, pointing at its relationship", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient;
        return yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Comment, {
              attributes: { body: "Who wrote this?" },
              relationships: { author: { data: Person.ref("does-not-exist") } },
            }),
          ),
        });
      }),
    );

    assert(Exit.isFailure(exit));
    const error = findFailure(exit.cause);
    assert(error instanceof PersonNotFound);
    expect(error.pointer).toBe("/atomic:operations/0/data/relationships/author/data");
  });

  it("a tags op naming an unknown tag 404s at that identifier and rolls back", async () => {
    const { exit, tags } = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;
        const exit = yield* Effect.exit(
          client.operations.operations({
            payload: Atomic.request(
              // this one would succeed (clearing the tags)...
              Atomic.updateRelationship(Article, sampleArticle.id, "tags", []),
              // ...but this one names a tag the store does not hold
              Atomic.addToRelationship(Article, sampleArticle.id, "tags", [
                Tag.ref(sampleTag.id),
                Tag.ref("does-not-exist"),
              ]),
            ),
          }),
        );
        const after = yield* client.articles.get({ params: { id: sampleArticle.id }, query: {} });
        return { exit, tags: after.data?.relationships?.tags.data };
      }),
    );

    assert(Exit.isFailure(exit));
    const error = findFailure(exit.cause);
    assert(error instanceof TagNotFound);
    expect(error.id).toBe("does-not-exist");
    expect(error.pointer).toBe("/atomic:operations/1/data/1");
    // all-or-nothing: the clearing operation was not committed either
    expect(tags).toEqual([Tag.ref(sampleTag.id)]);
  });

  it("an article add linking an unknown tag 404s at its relationship", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient;
        return yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Article, {
              attributes: {
                title: "Tagged with nothing",
                body: "",
                createdAt: sampleArticle.attributes.createdAt,
              },
              relationships: {
                author: { data: Person.ref(sampleAuthor.id) },
                tags: { data: [Tag.ref("does-not-exist")] },
              },
            }),
          ),
        });
      }),
    );

    assert(Exit.isFailure(exit));
    const error = findFailure(exit.cause);
    assert(error instanceof TagNotFound);
    expect(error.pointer).toBe("/atomic:operations/0/data/relationships/tags/data/0");
  });

  it("a comments op naming an unknown comment 404s and links none of its batch", async () => {
    const { exit, linked } = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;
        const before = yield* client.articles.commentsRelationship({
          params: { id: sampleArticle.id },
          query: {},
        });
        const exit = yield* Effect.exit(
          client.operations.operations({
            payload: Atomic.request(
              // a comment created earlier in the same request is linkable...
              Atomic.add(Comment, {
                lid: "fresh",
                attributes: { body: "Created in this request" },
                relationships: { author: { data: Person.ref(sampleAuthor.id) } },
              }),
              // ...but the unknown one fails the whole request
              Atomic.addToRelationship(Article, sampleArticle.id, "comments", [
                Comment.lidRef("fresh"),
                Comment.ref("does-not-exist"),
              ]),
            ),
          }),
        );
        const after = yield* client.articles.commentsRelationship({
          params: { id: sampleArticle.id },
          query: {},
        });
        return {
          exit,
          linked: {
            before: before.data.map((ref) => ref.id),
            after: after.data.map((ref) => ref.id),
          },
        };
      }),
    );

    assert(Exit.isFailure(exit));
    const error = findFailure(exit.cause);
    assert(error instanceof CommentNotFound);
    expect(error.id).toBe("does-not-exist");
    expect(error.pointer).toBe("/atomic:operations/1/data/1");
    expect(linked.after).toEqual(linked.before);
  });

  it("a remove naming an unknown tag or comment succeeds, removing the rest", async () => {
    // #477: a resource that does not exist is already missing from the
    // relationship, so a `remove` naming one is applied, not refused with a
    // 404. The article is the request's own, so the shared sample is untouched.
    const comment = sampleComments[0];
    assert(comment !== undefined);
    const { tags, comments } = await run(
      Effect.gen(function* () {
        const client = yield* buildClient;
        const created = yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.add(Article, {
              lid: "a1",
              attributes: {
                title: "Removing what is not there",
                body: "",
                createdAt: sampleArticle.attributes.createdAt,
              },
              relationships: {
                author: { data: Person.ref(sampleAuthor.id) },
                tags: { data: [Tag.ref(sampleTag.id)] },
              },
            }),
            Atomic.addToRelationship(Article, { lid: "a1" }, "comments", [Comment.ref(comment.id)]),
          ),
        });
        const added = created["atomic:results"][0]?.data;
        assert(added !== undefined && added !== null);
        const id = Article.Id.make(added.id);
        yield* client.operations.operations({
          payload: Atomic.request(
            Atomic.removeFromRelationship(Article, id, "tags", [
              Tag.ref(sampleTag.id),
              Tag.ref("does-not-exist"),
            ]),
            Atomic.removeFromRelationship(Article, id, "comments", [
              Comment.ref("does-not-exist"),
              Comment.ref(comment.id),
            ]),
          ),
        });
        const article = yield* client.articles.get({ params: { id }, query: {} });
        const linked = yield* client.articles.commentsRelationship({ params: { id }, query: {} });
        return {
          tags: article.data?.relationships?.tags.data,
          comments: linked.data.map((ref) => ref.id),
        };
      }),
    );

    expect(tags).toEqual([]);
    expect(comments).toEqual([]);
  });

  it("the 404's error document carries the pointer as source.pointer", () => {
    const encoded = Schema.encodeSync(PersonNotFound.wire)(
      new PersonNotFound({ id: "does-not-exist", pointer: "/atomic:operations/1/data" }),
    );
    expect(encoded.errors[0]?.status).toBe("404");
    expect(encoded.errors[0]?.code).toBe("person_not_found");
    expect(encoded.errors[0]?.source).toEqual({ pointer: "/atomic:operations/1/data" });
  });
});

describe("atomic operations: the wire format", () => {
  it("error documents point at the failing operation", () => {
    const encoded = Schema.encodeUnknownSync(OperationFailed.wire)(
      new OperationFailed({ operation: 1, reason: "article not found" }),
    ) as typeof ApiError.WireDocument.Type;
    expect(encoded.errors[0]?.detail).toBe(
      "Operation at /atomic:operations/1 failed: article not found",
    );
    expect(encoded.errors[0]?.status).toBe("422");
    expect(encoded.errors[0]?.meta).toEqual({ operation: 1, reason: "article not found" });
  });

  it("OpenAPI documents the operations endpoint with the extension media type", () => {
    const spec = OpenApi.fromApi(Api);
    expect(spec.paths["/operations"]?.post).toBeDefined();
    const json = JSON.stringify(spec.paths["/operations"]);
    expect(json).toContain("atomic");
  });

  it("content negotiation accepts the extension media type only when configured", () => {
    expect(
      Middleware.contentTypeIsAcceptable(Atomic.MEDIA_TYPE, { extensions: [Atomic.EXTENSION_URI] }),
    ).toBe(true);
    expect(Middleware.contentTypeIsAcceptable(Atomic.MEDIA_TYPE)).toBe(false);
  });
});
