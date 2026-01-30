import { describe, it, expect } from "vitest"
import * as Builder from "../Builder"

describe("Builder", () => {
  describe("resource", () => {
    it("should create a basic resource object", () => {
      const resource = Builder.resource("articles", "1", {
        title: "Test Article",
        body: "Test content",
      })

      expect(resource).toEqual({
        type: "articles",
        id: "1",
        attributes: {
          title: "Test Article",
          body: "Test content",
        },
      })
    })

    it("should create a resource with relationships", () => {
      const resource = Builder.resource(
        "articles",
        "1",
        { title: "Test" },
        {
          relationships: {
            author: Builder.toOneRelationship(
              Builder.resourceIdentifier("people", "9")
            ),
          },
        }
      )

      expect(resource.relationships?.author).toEqual({
        data: { type: "people", id: "9" },
      })
    })
  })

  describe("resourceIdentifier", () => {
    it("should create a resource identifier", () => {
      const identifier = Builder.resourceIdentifier("articles", "1")

      expect(identifier).toEqual({
        type: "articles",
        id: "1",
      })
    })

    it("should create a resource identifier with meta", () => {
      const identifier = Builder.resourceIdentifier("articles", "1", {
        version: "1.0",
      })

      expect(identifier).toEqual({
        type: "articles",
        id: "1",
        meta: { version: "1.0" },
      })
    })
  })

  describe("toOneRelationship", () => {
    it("should create a to-one relationship", () => {
      const relationship = Builder.toOneRelationship(
        Builder.resourceIdentifier("people", "9")
      )

      expect(relationship).toEqual({
        data: { type: "people", id: "9" },
      })
    })

    it("should create a null relationship", () => {
      const relationship = Builder.toOneRelationship(null)

      expect(relationship).toEqual({
        data: null,
      })
    })
  })

  describe("toManyRelationship", () => {
    it("should create a to-many relationship", () => {
      const relationship = Builder.toManyRelationship([
        Builder.resourceIdentifier("comments", "5"),
        Builder.resourceIdentifier("comments", "12"),
      ])

      expect(relationship).toEqual({
        data: [
          { type: "comments", id: "5" },
          { type: "comments", id: "12" },
        ],
      })
    })

    it("should create an empty to-many relationship", () => {
      const relationship = Builder.toManyRelationship([])

      expect(relationship).toEqual({
        data: [],
      })
    })
  })

  describe("successOne", () => {
    it("should create a success document with one resource", () => {
      const resource = Builder.resource("articles", "1", { title: "Test" })
      const document = Builder.successOne(resource)

      expect(document).toEqual({
        data: resource,
      })
    })

    it("should create a success document with meta", () => {
      const resource = Builder.resource("articles", "1", { title: "Test" })
      const document = Builder.successOne(resource, {
        meta: { version: "1.0" },
      })

      expect(document.meta).toEqual({ version: "1.0" })
    })

    it("should create a success document with included resources", () => {
      const article = Builder.resource("articles", "1", { title: "Test" })
      const author = Builder.resource("people", "9", { name: "John Doe" })
      const document = Builder.successOne(article, {
        included: [author],
      })

      expect(document.included).toEqual([author])
    })
  })

  describe("successMany", () => {
    it("should create a success document with multiple resources", () => {
      const resources = [
        Builder.resource("articles", "1", { title: "Test 1" }),
        Builder.resource("articles", "2", { title: "Test 2" }),
      ]
      const document = Builder.successMany(resources)

      expect(document).toEqual({
        data: resources,
      })
    })

    it("should create a success document with empty array", () => {
      const document = Builder.successMany([])

      expect(document).toEqual({
        data: [],
      })
    })
  })

  describe("error", () => {
    it("should create an error object", () => {
      const errorObj = Builder.error({
        status: "404",
        title: "Not Found",
        detail: "Resource not found",
      })

      expect(errorObj).toEqual({
        status: "404",
        title: "Not Found",
        detail: "Resource not found",
      })
    })

    it("should create an error with source pointer", () => {
      const errorObj = Builder.error({
        status: "422",
        title: "Validation Error",
        detail: "Title is required",
        source: { pointer: "/data/attributes/title" },
      })

      expect(errorObj.source).toEqual({
        pointer: "/data/attributes/title",
      })
    })
  })

  describe("errorDocument", () => {
    it("should create an error document", () => {
      const errors = [
        Builder.error({
          status: "404",
          title: "Not Found",
        }),
      ]
      const document = Builder.errorDocument(errors)

      expect(document).toEqual({
        errors,
      })
    })

    it("should create an error document with meta", () => {
      const errors = [Builder.error({ status: "500" })]
      const document = Builder.errorDocument(errors, {
        meta: { timestamp: "2024-01-01" },
      })

      expect(document.meta).toEqual({ timestamp: "2024-01-01" })
    })
  })
})
