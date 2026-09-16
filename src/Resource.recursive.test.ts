/**
 * Mutually-recursive resource definitions (#118): `Article ⇄ Comment`, a
 * to-many and its inverse to-one — the ordinary JSON:API graph.
 *
 * The type-level half is pinned in `test/recursive-resources.types.ts`. This is
 * the runtime half: everything derived from a resource has to keep working
 * across the cycle, and nothing may diverge.
 */
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import * as Query from "./Query.js"
import * as Relationship from "./Relationship.js"
import * as Resource from "./Resource.js"

const articleAttributes = { title: Schema.NonEmptyString }
const commentAttributes = { body: Schema.NonEmptyString }

type ArticleResource = Resource.Resource<
  "articles",
  typeof articleAttributes,
  { comments: Relationship.Many<CommentResource> }
>

type CommentResource = Resource.Resource<
  "comments",
  typeof commentAttributes,
  { article: Relationship.One<ArticleResource, false> }
>

const Article: ArticleResource = Resource.make("articles", {
  attributes: articleAttributes,
  relationships: { comments: Relationship.many(() => Comment) }
})

const Comment: CommentResource = Resource.make("comments", {
  attributes: commentAttributes,
  relationships: { article: Relationship.one(() => Article) }
})

const decode = (schema: Schema.Top, value: unknown): unknown =>
  Schema.decodeUnknownSync(schema as Schema.Codec<unknown, unknown>)(value)

describe("a mutually-recursive pair is a pair of ordinary resources", () => {
  it("resolves each relationship's target through the cycle", () => {
    expect(Article.relationships.comments.ref()).toBe(Comment)
    expect(Comment.relationships.article.ref()).toBe(Article)
  })

  it("keeps both complete", () => {
    expect(Article.type).toBe("articles")
    expect(Comment.type).toBe("comments")
    expect(Resource.attributeKeys(Article)).toEqual(["title"])
    expect(Resource.attributeKeys(Comment)).toEqual(["body"])
    expect(Article.ref("1")).toEqual({ type: "articles", id: "1" })
    expect(Comment.ref("c1")).toEqual({ type: "comments", id: "c1" })
  })
})

describe("the include surface terminates", () => {
  it("bounds the runtime walk by depth rather than looping", () => {
    expect(Resource.includePaths(Article, 2)).toEqual(["comments", "comments.article"])
    expect(Resource.includePaths(Comment, 2)).toEqual(["article", "article.comments"])
  })

  it("agrees with the advertised parameter, which is what the type mirrors", () => {
    // `Query.Include` walks to depth 2 — the same set `Resource.IncludePath`
    // models, so "advertised" and "typed" cannot drift across a cycle.
    const include = Query.Include(Article)
    expect(decode(include, "comments")).toEqual(["comments"])
    expect(decode(include, "comments.article")).toEqual(["comments.article"])
    expect(decode(include, "comments,comments.article")).toEqual(["comments", "comments.article"])
    expect(() => decode(include, "comments.article.comments")).toThrow()
    expect(() => decode(include, "nope")).toThrow()
  })

  it("makes the `included` union finite — one hop, not a loop", () => {
    expect(Resource.directTargets(Article).map((r) => r.type)).toEqual(["comments"])
    expect(Resource.directTargets(Comment).map((r) => r.type)).toEqual(["articles"])
  })
})

describe("documents decode across the cycle", () => {
  it("decodes an article with its comments included, each pointing back", () => {
    const value = {
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Hello" },
        relationships: { comments: { data: [{ type: "comments", id: "c1" }] } }
      },
      included: [
        {
          type: "comments",
          id: "c1",
          attributes: { body: "Nice" },
          relationships: { article: { data: { type: "articles", id: "1" } } }
        }
      ]
    }
    expect(decode(Article.document(), value)).toEqual(value)
  })

  it("decodes the inverse: a comment with its article included", () => {
    const value = {
      data: {
        type: "comments",
        id: "c1",
        attributes: { body: "Nice" },
        relationships: { article: { data: { type: "articles", id: "1" } } }
      },
      included: [
        {
          type: "articles",
          id: "1",
          attributes: { title: "Hello" },
          relationships: { comments: { data: [{ type: "comments", id: "c1" }] } }
        }
      ]
    }
    expect(decode(Comment.document(), value)).toEqual(value)
  })

  it("decodes a collection document on either side", () => {
    expect(
      decode(Comment.collection(), {
        data: [
          {
            type: "comments",
            id: "c1",
            attributes: { body: "Nice" },
            relationships: { article: { data: { type: "articles", id: "1" } } }
          }
        ]
      })
    ).toBeDefined()
  })

  it("rejects a resource of the wrong type in `included`", () => {
    expect(() =>
      decode(Article.document(), {
        data: { type: "articles", id: "1", attributes: { title: "Hello" } },
        included: [{ type: "people", id: "9", attributes: { firstName: "Ada" } }]
      })
    ).toThrow()
  })
})

describe("write payload derivation is unaffected on both sides", () => {
  it("requires the inverse to-one when creating a comment", () => {
    const value = {
      data: {
        type: "comments",
        attributes: { body: "New" },
        relationships: { article: { data: { type: "articles", id: "1" } } }
      }
    }
    expect(decode(Comment.createPayload, value)).toEqual(value)
    // `article` is a `one`, so it is required at create.
    expect(() => decode(Comment.createPayload, { data: { type: "comments", attributes: { body: "New" } } })).toThrow()
  })

  it("leaves a to-many optional when creating an article", () => {
    const value = { data: { type: "articles", attributes: { title: "New" } } }
    expect(decode(Article.createPayload, value)).toEqual(value)
  })

  it("derives partial update payloads on both sides", () => {
    expect(
      decode(Article.updatePayload, { data: { type: "articles", id: "1", attributes: { title: "Edited" } } })
    ).toBeDefined()
    expect(
      decode(Comment.updatePayload, { data: { type: "comments", id: "c1", attributes: { body: "Edited" } } })
    ).toBeDefined()
  })

  it("derives the flat inputs on both sides", () => {
    expect(Object.keys(Article.createInput.fields)).toEqual(["title"])
    expect(Object.keys(Comment.createInput.fields)).toEqual(["body"])
    expect(Object.keys(Article.updateInput.fields)).toEqual(["title", "id"])
    expect(Object.keys(Comment.updateInput.fields)).toEqual(["body", "id"])
  })
})

describe("the rest of the resource surface crosses the cycle", () => {
  it("extends a resource that takes part in one", () => {
    const Draft = Resource.extend(Article, "drafts", { attributes: { note: Schema.String } })
    expect(Object.keys(Resource.declaredAttributes(Draft))).toEqual(["title", "note"])
    expect(Draft.relationships.comments.ref()).toBe(Comment)
  })

  it("annotates a resource that takes part in one", () => {
    const annotated = Resource.annotate(Comment, { "@acme/storage": { table: "comments" } })
    expect(Resource.annotations(annotated)["@acme/storage"]).toEqual({ table: "comments" })
    expect(annotated.relationships.article.ref()).toBe(Article)
  })

  it("reports attribute descriptors on both sides", () => {
    expect(Resource.attributeDescriptors(Article).map((d) => d.key)).toEqual(["title"])
    expect(Resource.attributeDescriptors(Comment).map((d) => d.key)).toEqual(["body"])
  })
})
