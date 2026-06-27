import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema } from "effect"
import * as Document from "./Document.js"
import * as Handlers from "./Handlers.js"
import * as Resource from "./Resource.js"

const article = {
  type: "articles",
  id: "1",
  attributes: { title: "Hello" },
  relationships: {
    author: { data: { type: "people", id: "9" } },
    comments: { data: [{ type: "comments", id: "5" }] }
  }
}

const author = { type: "people", id: "9", attributes: { firstName: "John" } }
const comment = {
  type: "comments",
  id: "5",
  attributes: { body: "Nice" },
  relationships: { author: { data: { type: "people", id: "9" } } }
}
const stranger = { type: "people", id: "404", attributes: { firstName: "Nobody" } }

describe("Handlers.data", () => {
  it("builds a minimal document", () => {
    expect(Handlers.data(article)).toEqual({ data: article })
  })

  it("builds a null-data document", () => {
    expect(Handlers.data(null)).toEqual({ data: null })
  })

  it("adds self links, extra links and meta", () => {
    const doc = Handlers.data(article, {
      self: "/articles/1",
      links: { related: "/articles/1/related" },
      meta: { copyright: "ACME" }
    })
    expect(doc).toEqual({
      data: article,
      links: { self: "/articles/1", related: "/articles/1/related" },
      meta: { copyright: "ACME" }
    })
  })

  it("includes referenced resources", () => {
    const doc = Handlers.data(article, { included: [author, comment] })
    expect(doc.included).toEqual([author, comment])
  })

  it("deduplicates included resources by (type, id)", () => {
    const doc = Handlers.data(article, { included: [author, author, comment] })
    expect(doc.included).toEqual([author, comment])
  })

  it("enforces full linkage: unreferenced included resources throw", () => {
    expect(() => Handlers.data(article, { included: [stranger] })).toThrow(/full linkage/)
  })

  it("allows transitively referenced included resources", () => {
    // `comment` references `author`; both are linked.
    const commentOnlyArticle = {
      type: "articles",
      id: "1",
      relationships: { comments: { data: [{ type: "comments", id: "5" }] } }
    }
    const doc = Handlers.data(commentOnlyArticle, { included: [comment, author] })
    expect(doc.included).toEqual([comment, author])
  })

  it("linkage check can be disabled", () => {
    const doc = Handlers.data(article, { included: [stranger], checkLinkage: false })
    expect(doc.included).toEqual([stranger])
  })
})

describe("Handlers.collection", () => {
  it("builds a collection document", () => {
    const doc = Handlers.collection([article], {
      included: [author],
      meta: { total: 1 },
      self: "/articles"
    })
    expect(doc).toEqual({
      data: [article],
      included: [author],
      links: { self: "/articles" },
      meta: { total: 1 }
    })
  })

  it("builds an empty collection", () => {
    expect(Handlers.collection([])).toEqual({ data: [] })
  })
})

describe("Handlers.linkage", () => {
  it("builds a to-one linkage document", () => {
    expect(Handlers.linkage({ type: "people", id: "9" })).toEqual({
      data: { type: "people", id: "9" }
    })
  })

  it("builds an empty to-one linkage document", () => {
    expect(Handlers.linkage(null)).toEqual({ data: null })
  })

  it("builds a to-many linkage document", () => {
    expect(
      Handlers.linkage([
        { type: "comments", id: "5" },
        { type: "comments", id: "12" }
      ])
    ).toEqual({
      data: [
        { type: "comments", id: "5" },
        { type: "comments", id: "12" }
      ]
    })
  })

  it("adds self/related links and meta", () => {
    const doc = Handlers.linkage([{ type: "comments", id: "5" }], {
      self: "/articles/1/relationships/comments",
      related: "/articles/1/comments",
      meta: { count: 1 }
    })
    expect(doc).toEqual({
      data: [{ type: "comments", id: "5" }],
      links: {
        self: "/articles/1/relationships/comments",
        related: "/articles/1/comments"
      },
      meta: { count: 1 }
    })
  })

  it("merges extra links (e.g. pagination)", () => {
    const doc = Handlers.linkage([], {
      self: "/articles/1/relationships/comments",
      links: { next: "/articles/1/relationships/comments?page[offset]=10" }
    })
    expect(doc.links).toEqual({
      self: "/articles/1/relationships/comments",
      next: "/articles/1/relationships/comments?page[offset]=10"
    })
  })
})

describe("relationship URL helpers", () => {
  it("relationshipLink builds the relationship-endpoint URL", () => {
    expect(Handlers.relationshipLink("articles", "1", "comments")).toBe("/articles/1/relationships/comments")
  })

  it("relatedLink builds the related-resource URL", () => {
    expect(Handlers.relatedLink("articles", "1", "comments")).toBe("/articles/1/comments")
  })

  it("paginatedRelationship builds a links-only relationship object", () => {
    expect(Handlers.paginatedRelationship("people", "9", "articles")).toEqual({
      links: {
        self: "/people/9/relationships/articles",
        related: "/people/9/articles"
      }
    })
  })
})

describe("pagination links", () => {
  it("offset pagination: first page", () => {
    const links = Handlers.offsetPaginationLinks("/articles", { offset: 0, limit: 10 }, 35)
    expect(links).toEqual({
      self: "/articles?page[offset]=0&page[limit]=10",
      first: "/articles?page[offset]=0&page[limit]=10",
      prev: null,
      next: "/articles?page[offset]=10&page[limit]=10",
      last: "/articles?page[offset]=30&page[limit]=10"
    })
  })

  it("offset pagination: middle page", () => {
    const links = Handlers.offsetPaginationLinks("/articles", { offset: 10, limit: 10 }, 35)
    expect(links.prev).toBe("/articles?page[offset]=0&page[limit]=10")
    expect(links.next).toBe("/articles?page[offset]=20&page[limit]=10")
  })

  it("offset pagination: last page has no next", () => {
    const links = Handlers.offsetPaginationLinks("/articles", { offset: 30, limit: 10 }, 35)
    expect(links.next).toBeNull()
    expect(links.last).toBe("/articles?page[offset]=30&page[limit]=10")
  })

  it("number pagination: pages are 1-based", () => {
    const links = Handlers.numberPaginationLinks("/articles", { number: 2, size: 10 }, 35)
    expect(links).toEqual({
      self: "/articles?page[number]=2&page[size]=10",
      first: "/articles?page[number]=1&page[size]=10",
      prev: "/articles?page[number]=1&page[size]=10",
      next: "/articles?page[number]=3&page[size]=10",
      last: "/articles?page[number]=4&page[size]=10"
    })
  })

  it("preserves existing query strings in the path", () => {
    const links = Handlers.offsetPaginationLinks("/articles?sort=-createdAt", { offset: 0, limit: 10 }, 5)
    expect(links.self).toBe("/articles?sort=-createdAt&page[offset]=0&page[limit]=10")
  })
})

describe("Handlers.DocumentValue / Document.Value", () => {
  const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } })
  const value = Article.make({ id: Article.Id.make("1"), attributes: { title: "Hi" } })

  it("DocumentValue names the value type Handlers.data returns", () => {
    const named: Handlers.DocumentValue<typeof Article.Type> = Handlers.data(value)
    expect(named.data.id).toBe("1")
  })

  it("DocumentValue carries an optional jsonapi member", () => {
    const doc: Handlers.DocumentValue<typeof Article.Type> = { data: value, jsonapi: { version: "1.1" } }
    expect(doc.jsonapi?.version).toBe("1.1")
    expectTypeOf<Handlers.JsonApiObjectValue>().toEqualTypeOf<typeof Document.JsonApiObject.Type>()
  })

  it("Document.Value names a data-document value type", () => {
    const doc: Document.Value<typeof Article> = {
      data: Schema.decodeUnknownSync(Article)({ type: "articles", id: "1", attributes: { title: "Hi" } }),
      jsonapi: { version: "1.1" }
    }
    expect(doc.data.id).toBe("1")
  })

  it("Document.Value carries included and meta when parameterized", () => {
    const item = Schema.decodeUnknownSync(Article)({ type: "articles", id: "1", attributes: { title: "Hi" } })
    const doc: Document.Value<typeof Article, typeof Article, typeof Document.AnyMeta> = {
      data: item,
      included: [item],
      meta: { note: "x" }
    }
    expect(doc.included?.[0]?.id).toBe("1")
    expect(doc.meta?.note).toBe("x")
  })
})
