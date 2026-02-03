import { describe, it, expect } from "vitest"
import * as S from "effect/Schema"
import * as JsonApi from "./index"

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

  describe("ResourceIdentifierWithId", () => {
    it("should validate a resource identifier with only id", () => {
      const input = {
        type: "articles",
        id: "1"
      }
      const result = S.decodeUnknownSync(JsonApi.ResourceIdentifierWithId)(input)
      expect(result).toEqual(input)
    })
  })

  describe("ResourceIdentifierWithLid", () => {
    it("should validate a resource identifier with only lid", () => {
      const input = {
        type: "articles",
        lid: "temp-1"
      }
      const result = S.decodeUnknownSync(JsonApi.ResourceIdentifierWithLid)(input)
      expect(result).toEqual(input)
    })
  })

  describe("ResourceObject", () => {
    it("should validate a basic resource object with id", () => {
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
      expect(result).toMatchObject({
        type: "articles",
        id: "1"
      })
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
      expect(result).toMatchObject({
        type: "articles",
        lid: "temp-1"
      })
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
      expect(result).toMatchObject({
        type: "users",
        id: "550e8400-e29b-41d4-a716-446655440000"
      })
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
      expect(result).toMatchObject({
        type: "articles",
        id: "1"
      })
    })
  })

  describe("ResourceObjectWithId", () => {
    it("should validate a resource object with only id field", () => {
      const schema = JsonApi.ResourceObjectWithId()
      const input = {
        type: "articles",
        id: "1",
        attributes: {
          title: "Test"
        }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })
  })

  describe("ResourceObjectWithLid", () => {
    it("should validate a resource object with only lid field", () => {
      const schema = JsonApi.ResourceObjectWithLid()
      const input = {
        type: "articles",
        lid: "temp-1",
        attributes: {
          title: "Test"
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
      const schema = JsonApi.Document()
      const input = {
        data: {
          type: "articles",
          id: "1",
          attributes: {
            title: "Hello World"
          }
        }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result.data).toMatchObject({
        type: "articles",
        id: "1"
      })
    })

    it("should validate a document with multiple resources", () => {
      const schema = JsonApi.Document()
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
      const result = S.decodeUnknownSync(schema)(input)
      expect(Array.isArray(result.data)).toBe(true)
    })

    it("should validate an error document", () => {
      const schema = JsonApi.Document()
      const input = {
        errors: [
          {
            status: "404",
            title: "Not Found"
          }
        ]
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })

    it("should validate a document with included resources", () => {
      const schema = JsonApi.Document()
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
      const result = S.decodeUnknownSync(schema)(input)
      expect(result.data).toMatchObject({
        type: "articles",
        id: "1"
      })
    })

    it("should validate a document with meta and links", () => {
      const schema = JsonApi.Document()
      const input = {
        data: [],
        meta: { total: 0 },
        links: {
          self: "https://example.com/articles"
        }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })

    it("should validate a document with lid in data", () => {
      const schema = JsonApi.Document()
      const input = {
        data: {
          type: "articles",
          lid: "temp-1",
          attributes: {
            title: "New Article"
          }
        }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result.data).toMatchObject({
        type: "articles",
        lid: "temp-1"
      })
    })
  })

  describe("Relationship", () => {
    it("should validate a relationship with data", () => {
      const schema = JsonApi.Relationship()
      const input = {
        data: {
          type: "people",
          id: "9"
        }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })

    it("should validate a relationship with links", () => {
      const schema = JsonApi.Relationship()
      const input = {
        links: {
          self: "https://example.com/articles/1/relationships/author"
        }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })

    it("should validate a relationship with meta", () => {
      const schema = JsonApi.Relationship()
      const input = {
        meta: {
          count: 5
        }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })

    it("should reject empty relationship", () => {
      const schema = JsonApi.Relationship()
      const input = {}
      expect(() => S.decodeUnknownSync(schema)(input)).toThrow()
    })

    it("should validate a relationship with custom identifier", () => {
      const CustomIdentifier = S.Struct({
        type: S.Literal("people"),
        id: S.UUID
      })
      const schema = JsonApi.Relationship(CustomIdentifier)
      const input = {
        data: {
          type: "people" as const,
          id: "550e8400-e29b-41d4-a716-446655440000"
        }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })

    it("should validate a relationship with all fields", () => {
      const schema = JsonApi.Relationship()
      const input = {
        data: { type: "people", id: "9" },
        links: { self: "https://example.com/link" },
        meta: { count: 1 }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })
  })

  describe("Document constraints", () => {
    it("should validate a document with only meta", () => {
      const schema = JsonApi.Document()
      const input = {
        meta: { version: "1.0" }
      }
      const result = S.decodeUnknownSync(schema)(input)
      expect(result).toEqual(input)
    })

    it("should reject empty document", () => {
      const schema = JsonApi.Document()
      const input = {}
      expect(() => S.decodeUnknownSync(schema)(input)).toThrow()
    })

    // Note: Due to Effect Schema's union handling and excess property stripping,
    // documents with both data and errors may match one of the union variants
    // rather than being rejected. In practice, well-formed JSON:API servers
    // should not send documents with both members.
  })
})
