import { describe, it, expect } from "vitest"
import * as S from "effect/Schema"
import * as Schema from "../Schema"

describe("Schema", () => {
  describe("ResourceIdentifier", () => {
    it("should validate a valid resource identifier", () => {
      const input = {
        type: "articles",
        id: "1"
      }
      
      const result = S.decodeUnknownSync(Schema.ResourceIdentifier)(input)
      expect(result).toEqual(input)
    })

    it("should validate a resource identifier with meta", () => {
      const input = {
        type: "articles",
        id: "1",
        meta: { version: "1.0" }
      }
      
      const result = S.decodeUnknownSync(Schema.ResourceIdentifier)(input)
      expect(result).toEqual(input)
    })
  })

  describe("ResourceObject", () => {
    it("should validate a basic resource object", () => {
      const input = {
        type: "articles",
        id: "1",
        attributes: {
          title: "Hello World",
          body: "This is a test"
        }
      }
      
      const result = S.decodeUnknownSync(Schema.ResourceObject)(input)
      expect(result).toEqual(input)
    })

    it("should validate a resource object with relationships", () => {
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
      
      const result = S.decodeUnknownSync(Schema.ResourceObject)(input)
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
      
      const result = S.decodeUnknownSync(Schema.ErrorObject)(input)
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
      
      const result = S.decodeUnknownSync(Schema.ErrorObject)(input)
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
      
      const result = S.decodeUnknownSync(Schema.Document)(input)
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
      
      const result = S.decodeUnknownSync(Schema.Document)(input)
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
      
      const result = S.decodeUnknownSync(Schema.Document)(input)
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
      
      const result = S.decodeUnknownSync(Schema.Document)(input)
      expect(result).toEqual(input)
    })

    it("should validate a document with meta and links", () => {
      const input = {
        data: [],
        meta: { total: 0 },
        links: {
          self: "/articles"
        }
      }
      
      const result = S.decodeUnknownSync(Schema.Document)(input)
      expect(result).toEqual(input)
    })
  })

  describe("ResourceObjectCreate", () => {
    it("should validate a create resource without id", () => {
      const input = {
        type: "articles",
        attributes: {
          title: "New Article",
          body: "Content"
        }
      }
      
      const result = S.decodeUnknownSync(Schema.ResourceObjectCreate)(input)
      expect(result).toEqual(input)
    })

    it("should validate a create resource with client-generated id", () => {
      const input = {
        type: "articles",
        id: "client-123",
        attributes: {
          title: "New Article"
        }
      }
      
      const result = S.decodeUnknownSync(Schema.ResourceObjectCreate)(input)
      expect(result).toEqual(input)
    })
  })

  describe("DocumentCreate", () => {
    it("should validate a create document without resource id", () => {
      const input = {
        data: {
          type: "articles",
          attributes: {
            title: "New Article",
            body: "Content"
          }
        }
      }
      
      const result = S.decodeUnknownSync(Schema.DocumentCreate)(input)
      expect(result).toEqual(input)
    })
  })
})
