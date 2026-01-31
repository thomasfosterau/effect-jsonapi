import { describe, it, expect } from "vitest"
import * as S from "effect/Schema"
import * as JsonApi from "../index"

describe("JSON:API Schemas", () => {
  describe("Link", () => {
    it("should validate a string link", () => {
      const input = "https://example.com/articles/1"
      const result = S.decodeUnknownSync(JsonApi.Link)(input)
      expect(result).toEqual(input)
    })

    it("should validate a link object", () => {
      const input = {
        href: "https://example.com/articles/1",
        meta: { count: 10 }
      }
      const result = S.decodeUnknownSync(JsonApi.Link)(input)
      expect(result).toEqual(input)
    })
  })

  describe("ResourceIdentifier", () => {
    it("should validate a resource identifier with id", () => {
      const input = {
        type: "articles",
        id: "1"
      }
      const result = S.decodeUnknownSync(JsonApi.ResourceIdentifier)(input)
      expect(result).toEqual(input)
    })

    it("should validate a resource identifier with lid", () => {
      const input = {
        type: "articles",
        lid: "temp-123"
      }
      const result = S.decodeUnknownSync(JsonApi.ResourceIdentifier)(input)
      expect(result).toEqual(input)
    })

    it("should validate a resource identifier with both id and lid", () => {
      const input = {
        type: "articles",
        id: "1",
        lid: "temp-1"
      }
      const result = S.decodeUnknownSync(JsonApi.ResourceIdentifier)(input)
      expect(result).toEqual(input)
    })

    it("should reject a resource identifier without id or lid", () => {
      const input = {
        type: "articles"
      }
      expect(() => S.decodeUnknownSync(JsonApi.ResourceIdentifier)(input)).toThrow()
    })

    it("should validate a resource identifier with meta", () => {
      const input = {
        type: "articles",
        id: "1",
        meta: { version: "1.0" }
      }
      const result = S.decodeUnknownSync(JsonApi.ResourceIdentifier)(input)
      expect(result).toEqual(input)
    })
  })

  describe("ResourceObject", () => {
    it("should validate a basic resource object", () => {
      const schema = JsonApi.ResourceObject()
      const input = {
        type: "articles",
        id: "1",
        attributes: {
          title: "Hello World",
          body: "This is a test"
        }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })

    it("should validate a resource object with lid", () => {
      const schema = JsonApi.ResourceObject()
      const input = {
        type: "articles",
        lid: "temp-1",
        attributes: {
          title: "New Article"
        }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })

    it("should validate a resource object with typed attributes", () => {
      const schema = JsonApi.ResourceObject({
        type: S.Literal("users"),
        id: S.UUID,
        attributes: S.Struct({
          name: S.String,
          email: S.String
        })
      })

      const input = {
        type: "users" as const,
        id: "550e8400-e29b-41d4-a716-446655440000",
        attributes: {
          name: "John Doe",
          email: "john@example.com"
        }
      }

      const result = S.decodeUnknownSync(schema)(input)
      expect(result.type).toBe("users")
      expect(result.attributes?.name).toBe("John Doe")
    })

    it("should validate a resource object with relationships", () => {
      const schema = JsonApi.ResourceObject()
      const input = {
        type: "articles",
        id: "1",
        attributes: {
          title: "Hello World"
        },
        relationships: {
          author: {
            data: {
              type: "people",
              id: "9"
            }
          }
        }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })
  })

  describe("ErrorObject", () => {
    it("should validate an error object", () => {
      const input = {
        status: "404",
        title: "Not Found",
        detail: "The requested resource does not exist"
      }
      const result = S.decodeUnknownSync(JsonApi.ErrorObject)(input)
      expect(result).toEqual(input)
    })

    it("should validate an error object with source", () => {
      const input = {
        status: "422",
        title: "Validation Error",
        detail: "Title is required",
        source: {
          pointer: "/data/attributes/title"
        }
      }
      const result = S.decodeUnknownSync(JsonApi.ErrorObject)(input)
      expect(result).toEqual(input)
    })
  })

  describe("Document", () => {
    it("should validate a document with single resource", () => {
      const input = {
        data: {
          type: "articles",
          id: "1",
          attributes: {
            title: "Hello World"
          }
        }
      }
      const result = S.decodeUnknownSync(JsonApi.Document)(input)
      expect(result).toEqual(input)
    })

    it("should validate a document with multiple resources", () => {
      const input = {
        data: [
          {
            type: "articles",
            id: "1",
            attributes: { title: "Article 1" }
          },
          {
            type: "articles",
            id: "2",
            attributes: { title: "Article 2" }
          }
        ]
      }
      const result = S.decodeUnknownSync(JsonApi.Document)(input)
      expect(result).toEqual(input)
    })

    it("should validate an error document", () => {
      const input = {
        errors: [
          {
            status: "404",
            title: "Not Found"
          }
        ]
      }
      const result = S.decodeUnknownSync(JsonApi.Document)(input)
      expect(result).toEqual(input)
    })

    it("should validate a document with included resources", () => {
      const input = {
        data: {
          type: "articles",
          id: "1",
          relationships: {
            author: {
              data: { type: "people", id: "9" }
            }
          }
        },
        included: [
          {
            type: "people",
            id: "9",
            attributes: { name: "John Doe" }
          }
        ]
      }
      const result = S.decodeUnknownSync(JsonApi.Document)(input)
      expect(result).toEqual(input)
    })

    it("should validate a document with meta and links", () => {
      const input = {
        data: [],
        meta: { total: 0 },
        links: {
          self: "https://example.com/articles"
        }
      }
      const result = S.decodeUnknownSync(JsonApi.Document)(input)
      expect(result).toEqual(input)
    })

    it("should validate a document with lid in data", () => {
      const input = {
        data: {
          type: "articles",
          lid: "temp-1",
          attributes: {
            title: "New Article"
          }
        }
      }
      const result = S.decodeUnknownSync(JsonApi.Document)(input)
      expect(result).toEqual(input)
    })
  })
})
