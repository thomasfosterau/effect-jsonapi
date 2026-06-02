import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { lidMap, UnknownLidError } from "./Lid.js"
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
    body: Schema.String
  },
  relationships: {
    author: toOne(() => Person),
    comments: toMany(() => Comment)
  }
})

// ---------------------------------------------------------------------------
// Lid resolution
// ---------------------------------------------------------------------------

describe("lidMap", () => {
  it("assigns and resolves lids", () => {
    const lids = lidMap()
    expect(lids.id("a1")).toBeUndefined()
    lids.assign("a1", "42")
    expect(lids.id("a1")).toBe("42")
  })

  it("resolves lid-based refs to typed identifiers", () => {
    const lids = lidMap()
    lids.assign("a1", "42")
    expect(lids.identifier(Article, { type: "articles", lid: "a1" })).toEqual({ type: "articles", id: "42" })
  })

  it("passes id-based refs through unchanged", () => {
    const lids = lidMap()
    expect(lids.identifier(Article, { type: "articles", id: "7" })).toEqual({ type: "articles", id: "7" })
  })

  it("throws UnknownLidError for unassigned lids", () => {
    const lids = lidMap()
    expect(() => lids.identifier(Article, { type: "articles", lid: "nope" })).toThrow(UnknownLidError)
    try {
      lids.identifier(Article, { type: "articles", lid: "nope" })
    } catch (error) {
      expect((error as UnknownLidError).lid).toBe("nope")
    }
  })

  it("throws when the ref type does not match the resource", () => {
    const lids = lidMap()
    expect(() => lids.identifier(Article, { type: "people", id: "9" })).toThrow(/does not match/)
  })

  it("resolves relationship linkage with mixed id- and lid-based refs", () => {
    const lids = lidMap()
    lids.assign("c1", "100")

    const linkage = lids.resolveLinkage(Article, {
      author: { data: { type: "people", id: "9" } },
      comments: { data: [{ type: "comments", lid: "c1" }, { type: "comments", id: "5" }] }
    })

    expect(linkage).toEqual({
      author: { data: { type: "people", id: "9" } },
      comments: { data: [{ type: "comments", id: "100" }, { type: "comments", id: "5" }] }
    })
  })

  it("resolves null linkage and undefined relationships", () => {
    const lids = lidMap()
    expect(lids.resolveLinkage(Article, { author: { data: null } })).toEqual({ author: { data: null } })
    expect(lids.resolveLinkage(Article, undefined)).toEqual({})
  })

  it("throws UnknownLidError for unassigned lids in linkage", () => {
    const lids = lidMap()
    expect(() =>
      lids.resolveLinkage(Article, {
        comments: { data: [{ type: "comments", lid: "never-created" }] }
      })
    ).toThrow(UnknownLidError)
  })

  it("works with refs made by Resource.lidRef", () => {
    const lids = lidMap()
    lids.assign("c1", "100")
    expect(lids.identifier(Comment, Comment.lidRef("c1"))).toEqual({ type: "comments", id: "100" })
  })
})
