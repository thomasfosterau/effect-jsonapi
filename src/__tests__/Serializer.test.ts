import { describe, it, expect } from "vitest"
import * as Serializer from "../Serializer"
import * as Builder from "../Builder"

describe("Serializer", () => {
  interface Article {
    id: string
    title: string
    body: string
    authorId: string
  }

  const sampleArticle: Article = {
    id: "1",
    title: "Test Article",
    body: "Test content",
    authorId: "42",
  }

  describe("serialize", () => {
    it("should serialize data to resource object", () => {
      const config: Serializer.SerializerConfig<Article> = {
        type: "articles",
        getId: (article) => article.id,
        getAttributes: (article) => ({
          title: article.title,
          body: article.body,
        }),
      }

      const resource = Serializer.serialize(config, sampleArticle)

      expect(resource).toEqual({
        type: "articles",
        id: "1",
        attributes: {
          title: "Test Article",
          body: "Test content",
        },
      })
    })

    it("should include relationships", () => {
      const config: Serializer.SerializerConfig<Article> = {
        type: "articles",
        getId: (article) => article.id,
        getAttributes: (article) => ({
          title: article.title,
          body: article.body,
        }),
        getRelationships: (article) => ({
          author: Builder.toOneRelationship(
            Builder.resourceIdentifier("people", article.authorId)
          ),
        }),
      }

      const resource = Serializer.serialize(config, sampleArticle)

      expect(resource.relationships?.author).toEqual({
        data: { type: "people", id: "42" },
      })
    })

    it("should include links", () => {
      const config: Serializer.SerializerConfig<Article> = {
        type: "articles",
        getId: (article) => article.id,
        getLinks: (article) => ({
          self: `/articles/${article.id}`,
        }),
      }

      const resource = Serializer.serialize(config, sampleArticle)

      expect(resource.links).toEqual({
        self: "/articles/1",
      })
    })

    it("should include meta", () => {
      const config: Serializer.SerializerConfig<Article> = {
        type: "articles",
        getId: (article) => article.id,
        getMeta: () => ({
          version: "1.0",
        }),
      }

      const resource = Serializer.serialize(config, sampleArticle)

      expect(resource.meta).toEqual({
        version: "1.0",
      })
    })
  })

  describe("serializeMany", () => {
    it("should serialize multiple items", () => {
      const articles: Article[] = [
        {
          id: "1",
          title: "Article 1",
          body: "Content 1",
          authorId: "42",
        },
        {
          id: "2",
          title: "Article 2",
          body: "Content 2",
          authorId: "43",
        },
      ]

      const config: Serializer.SerializerConfig<Article> = {
        type: "articles",
        getId: (article) => article.id,
        getAttributes: (article) => ({
          title: article.title,
          body: article.body,
        }),
      }

      const resources = Serializer.serializeMany(config, articles)

      expect(resources).toHaveLength(2)
      expect(resources[0].id).toBe("1")
      expect(resources[1].id).toBe("2")
    })

    it("should handle empty array", () => {
      const config: Serializer.SerializerConfig<Article> = {
        type: "articles",
        getId: (article) => article.id,
      }

      const resources = Serializer.serializeMany(config, [])

      expect(resources).toEqual([])
    })
  })

  describe("createSerializer", () => {
    it("should create a reusable serializer", () => {
      const config: Serializer.SerializerConfig<Article> = {
        type: "articles",
        getId: (article) => article.id,
        getAttributes: (article) => ({
          title: article.title,
          body: article.body,
        }),
      }

      const serializer = Serializer.createSerializer(config)
      const resource = serializer.serialize(sampleArticle)

      expect(resource.type).toBe("articles")
      expect(resource.id).toBe("1")
    })

    it("should serialize many with created serializer", () => {
      const config: Serializer.SerializerConfig<Article> = {
        type: "articles",
        getId: (article) => article.id,
        getAttributes: (article) => ({
          title: article.title,
        }),
      }

      const serializer = Serializer.createSerializer(config)
      const resources = serializer.serializeMany([sampleArticle])

      expect(resources).toHaveLength(1)
      expect(resources[0].attributes?.title).toBe("Test Article")
    })
  })

  describe("createSimpleSerializer", () => {
    it("should create a simple serializer for id-based entities", () => {
      const serializer = Serializer.createSimpleSerializer<Article>(
        "articles",
        (article) => ({
          title: article.title,
          body: article.body,
        })
      )

      const resource = serializer.serialize(sampleArticle)

      expect(resource).toEqual({
        type: "articles",
        id: "1",
        attributes: {
          title: "Test Article",
          body: "Test content",
        },
      })
    })

    it("should work without getAttributes", () => {
      const serializer = Serializer.createSimpleSerializer<Article>("articles")

      const resource = serializer.serialize(sampleArticle)

      expect(resource.type).toBe("articles")
      expect(resource.id).toBe("1")
      expect(resource.attributes).toBeUndefined()
    })
  })
})
