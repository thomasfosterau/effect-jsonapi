import { describe, expect, it } from "vitest"
import * as Handlers from "./Handlers.js"

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
