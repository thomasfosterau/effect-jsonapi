import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema } from "effect"
import * as Endpoint from "./Endpoint.js"
import * as Query from "./Query.js"
import * as Relationship from "./Relationship.js"
import { includePaths, make as Resource } from "./Resource.js"
import type { IncludePath, Resource as ResourceDefinition } from "./Resource.js"

// ---------------------------------------------------------------------------
// Mutually-recursive resource definitions (#118)
//
// The runtime graph has always been free to contain cycles — relationship
// references are thunks. What was missing was the *type*: `Resource.make`'s
// return type is inferred, so an `Article` ⇄ `Comment` pair made each
// definition's type depend on the other's and TypeScript refused both
// (TS7022 / TS7024).
//
// The escape is an explicit annotation on the recursive binding, the same one
// Effect's recursive schemas use: an `interface` per resource in the cycle.
// `test/recursive-resources.types.ts` pins the type-level half; this file
// checks the values it describes actually decode.
// ---------------------------------------------------------------------------

const articleAttributes = { title: Schema.NonEmptyString }
const commentAttributes = { body: Schema.NonEmptyString }

interface Article extends ResourceDefinition<
  "articles",
  typeof articleAttributes,
  {
    readonly comments: Relationship.many<Comment>
    readonly editor: Relationship.optional<Article>
    readonly revisions: Relationship.paginated<Article>
  }
> {}

interface Comment extends ResourceDefinition<
  "comments",
  typeof commentAttributes,
  {
    readonly article: Relationship.one<Article>
    readonly parent: Relationship.optional<Comment>
  }
> {}

const Article: Article = Resource("articles", {
  attributes: articleAttributes,
  relationships: {
    comments: Relationship.many(() => Comment),
    editor: Relationship.optional(() => Article),
    revisions: Relationship.paginated(() => Article)
  }
})

const Comment: Comment = Resource("comments", {
  attributes: commentAttributes,
  relationships: {
    article: Relationship.one(() => Article),
    parent: Relationship.optional(() => Comment)
  }
})

describe("mutually-recursive resource definitions", () => {
  it("resolves both sides of the cycle, in either declaration order", () => {
    expect(Article.type).toBe("articles")
    expect(Comment.type).toBe("comments")
    // `Comment` is referenced by `Article` before it is initialised; the thunk
    // is what makes that legal.
    expect(Article.relationships.comments.ref().type).toBe("comments")
    expect(Comment.relationships.article.ref().type).toBe("articles")
  })

  it("keeps inference across arbitrarily many hops", () => {
    const backAround = Article.relationships.comments.ref().relationships.article.ref()
    expect(backAround.type).toBe("articles")
    expectTypeOf(backAround.type).toEqualTypeOf<"articles">()
    expectTypeOf(Article.relationships.comments.ref().type).toEqualTypeOf<"comments">()
  })

  it("resolves self-edges", () => {
    expect(Article.relationships.editor.ref().type).toBe("articles")
    expect(Comment.relationships.parent.ref().type).toBe("comments")
  })

  it("decodes a compound document across the cycle", () => {
    const decoded = Schema.decodeUnknownSync(Article.document())({
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "JSON:API" },
        relationships: {
          comments: { data: [{ type: "comments", id: "9" }] },
          editor: { data: null },
          revisions: { links: { related: "/articles/1/revisions" } }
        }
      },
      included: [
        {
          type: "comments",
          id: "9",
          attributes: { body: "nice" },
          relationships: {
            article: { data: { type: "articles", id: "1" } },
            parent: { data: null }
          }
        }
      ]
    })

    expect(decoded.data.attributes.title).toBe("JSON:API")
    expect(decoded.data.relationships?.comments.data).toEqual([{ type: "comments", id: "9" }])
    expect(decoded.data.relationships?.editor.data).toBeNull()
    const [first] = decoded.included ?? []
    expect(first?.type).toBe("comments")
  })

  it("decodes the inverse document too", () => {
    const decoded = Schema.decodeUnknownSync(Comment.document())({
      data: {
        type: "comments",
        id: "9",
        attributes: { body: "nice" },
        relationships: {
          article: { data: { type: "articles", id: "1" } },
          parent: { data: null }
        }
      },
      included: [{ type: "articles", id: "1", attributes: { title: "JSON:API" } }]
    })

    expect(decoded.data.relationships?.article.data).toEqual({ type: "articles", id: "1" })
    const [first] = decoded.included ?? []
    expect(first?.type).toBe("articles")
  })

  it("keeps the included union finite — one hop, not the transitive closure", () => {
    // A cycle must not make the union infinite: `Article.document()` admits the
    // targets of Article's own linkable relationships and nothing further.
    const decoded = Schema.decodeUnknownSync(Article.document())({
      data: { type: "articles", id: "1", attributes: { title: "JSON:API" } },
      included: [{ type: "articles", id: "2", attributes: { title: "Editor's" } }]
    })
    expect(decoded.included).toHaveLength(1)

    expect(() =>
      Schema.decodeUnknownSync(Article.document())({
        data: { type: "articles", id: "1", attributes: { title: "JSON:API" } },
        // `people` is not a target of any Article relationship
        included: [{ type: "people", id: "3", attributes: { name: "Ada" } }]
      })
    ).toThrow()
  })

  it("bounds the include-path walk by depth, not by the graph", () => {
    const paths = includePaths(Article, 2)
    expect(paths).toContain("comments")
    expect(paths).toContain("comments.article")
    expect(paths).toContain("editor.comments")
    // `revisions` is paginated, so it never appears in an include path.
    expect(paths.some((path) => path.startsWith("revisions"))).toBe(false)
    // The walk terminates even though the graph does not.
    expect(paths.every((path) => path.split(".").length <= 2)).toBe(true)
  })

  it("derives the typed include whitelist across the cycle", () => {
    const query = Query.schema(Article, { include: true })
    expect(Schema.decodeUnknownSync(query)({ include: "comments.article" })).toEqual({
      include: ["comments.article"]
    })
    expectTypeOf<"comments.article">().toMatchTypeOf<IncludePath<Article>>()
    expectTypeOf<"comments.parent">().toMatchTypeOf<IncludePath<Article>>()
  })

  it("derives endpoints whose path comes from the resource's own type tag", () => {
    // An interface-annotated definition used to widen `Type` to `string` here,
    // taking every `Type`-derived default (the path first) down with it.
    expect(Endpoint.get(Article).path).toBe("/articles/:id")
    expect(Endpoint.list(Comment).path).toBe("/comments")
    expectTypeOf(Endpoint.get(Article).path).toEqualTypeOf<"/articles/:id">()
  })

  it("derives create and update payloads on both sides of the cycle", () => {
    const createComment = Schema.decodeUnknownSync(Comment.createPayload)({
      data: {
        type: "comments",
        attributes: { body: "first" },
        relationships: { article: { data: { type: "articles", id: "1" } } }
      }
    })
    expect(createComment.data.relationships.article.data).toEqual({ type: "articles", id: "1" })

    // A required `one` cannot be omitted, even across the cycle.
    expect(() =>
      Schema.decodeUnknownSync(Comment.createPayload)({
        data: { type: "comments", attributes: { body: "first" }, relationships: {} }
      })
    ).toThrow()

    const updateArticle = Schema.decodeUnknownSync(Article.updatePayload)({
      data: { type: "articles", id: "1", attributes: { title: "new" } }
    })
    expect(updateArticle.data.attributes?.title).toBe("new")
  })

  it("keeps ids branded per resource type across the cycle", () => {
    expect(Article.ref("1")).toEqual({ type: "articles", id: "1" })
    expect(Comment.ref("9")).toEqual({ type: "comments", id: "9" })
    expectTypeOf(Article.Id.make("1")).not.toEqualTypeOf(Comment.Id.make("1"))
  })
})

describe("self-recursive resource definitions", () => {
  const categoryAttributes = { name: Schema.NonEmptyString }

  interface Category extends ResourceDefinition<
    "categories",
    typeof categoryAttributes,
    {
      readonly parent: Relationship.optional<Category>
      readonly children: Relationship.many<Category>
    }
  > {}

  const Category: Category = Resource("categories", {
    attributes: categoryAttributes,
    relationships: {
      parent: Relationship.optional(() => Category),
      children: Relationship.many(() => Category)
    }
  })

  it("resolves a resource that references itself", () => {
    expect(Category.relationships.parent.ref().type).toBe("categories")
    expect(Category.relationships.children.ref()).toBe(Category)
  })

  it("decodes a self-referencing document", () => {
    const decoded = Schema.decodeUnknownSync(Category.document())({
      data: {
        type: "categories",
        id: "1",
        attributes: { name: "Root" },
        relationships: {
          parent: { data: null },
          children: { data: [{ type: "categories", id: "2" }] }
        }
      },
      included: [{ type: "categories", id: "2", attributes: { name: "Leaf" } }]
    })
    expect(decoded.data.relationships?.children.data).toEqual([{ type: "categories", id: "2" }])
    expect(decoded.included?.[0]?.attributes.name).toBe("Leaf")
  })
})
