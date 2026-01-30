import { describe, it, expect } from "vitest"
import * as QueryParams from "../QueryParams"

describe("QueryParams", () => {
  describe("parseFilter", () => {
    it("should parse filter parameters", () => {
      const params = new URLSearchParams("filter[status]=published&filter[category]=tech")
      const filter = QueryParams.parseFilter(params)

      expect(filter).toEqual({
        status: "published",
        category: "tech",
      })
    })

    it("should handle multiple values for the same filter", () => {
      const params = new URLSearchParams("filter[tags]=javascript&filter[tags]=typescript")
      const filter = QueryParams.parseFilter(params)

      expect(filter.tags).toEqual(["javascript", "typescript"])
    })

    it("should return empty object when no filters", () => {
      const params = new URLSearchParams()
      const filter = QueryParams.parseFilter(params)

      expect(filter).toEqual({})
    })
  })

  describe("parseSort", () => {
    it("should parse ascending sort", () => {
      const sort = QueryParams.parseSort("created")

      expect(sort).toEqual([{ field: "created", direction: "asc" }])
    })

    it("should parse descending sort", () => {
      const sort = QueryParams.parseSort("-created")

      expect(sort).toEqual([{ field: "created", direction: "desc" }])
    })

    it("should parse multiple sort fields", () => {
      const sort = QueryParams.parseSort("-created,title")

      expect(sort).toEqual([
        { field: "created", direction: "desc" },
        { field: "title", direction: "asc" },
      ])
    })

    it("should return empty array for null", () => {
      const sort = QueryParams.parseSort(null)

      expect(sort).toEqual([])
    })
  })

  describe("parsePage", () => {
    it("should parse page parameters", () => {
      const params = new URLSearchParams("page[number]=2&page[size]=10")
      const page = QueryParams.parsePage(params)

      expect(page).toEqual({
        number: "2",
        size: "10",
      })
    })

    it("should return empty object when no page params", () => {
      const params = new URLSearchParams()
      const page = QueryParams.parsePage(params)

      expect(page).toEqual({})
    })
  })

  describe("parseInclude", () => {
    it("should parse single include", () => {
      const include = QueryParams.parseInclude("author")

      expect(include).toEqual(["author"])
    })

    it("should parse multiple includes", () => {
      const include = QueryParams.parseInclude("author,comments")

      expect(include).toEqual(["author", "comments"])
    })

    it("should parse nested includes", () => {
      const include = QueryParams.parseInclude("author,comments.author")

      expect(include).toEqual(["author", "comments.author"])
    })

    it("should return empty array for null", () => {
      const include = QueryParams.parseInclude(null)

      expect(include).toEqual([])
    })

    it("should trim whitespace", () => {
      const include = QueryParams.parseInclude("author , comments , tags")

      expect(include).toEqual(["author", "comments", "tags"])
    })
  })

  describe("parseFields", () => {
    it("should parse sparse fieldsets", () => {
      const params = new URLSearchParams(
        "fields[articles]=title,body&fields[people]=name"
      )
      const fields = QueryParams.parseFields(params)

      expect(fields).toEqual({
        articles: ["title", "body"],
        people: ["name"],
      })
    })

    it("should return empty object when no fields", () => {
      const params = new URLSearchParams()
      const fields = QueryParams.parseFields(params)

      expect(fields).toEqual({})
    })
  })

  describe("parseQueryParams", () => {
    it("should parse all query parameters", () => {
      const url =
        "https://api.example.com/articles?filter[status]=published&sort=-created&page[number]=1&include=author"
      const params = QueryParams.parseQueryParams(url)

      expect(params).toEqual({
        filter: { status: "published" },
        sort: [{ field: "created", direction: "desc" }],
        page: { number: "1" },
        include: ["author"],
        fields: {},
      })
    })

    it("should handle URL objects", () => {
      const url = new URL(
        "https://api.example.com/articles?filter[status]=published"
      )
      const params = QueryParams.parseQueryParams(url)

      expect(params.filter).toEqual({ status: "published" })
    })

    it("should parse complex query", () => {
      const url =
        "https://api.example.com/articles?" +
        "filter[status]=published&filter[category]=tech&" +
        "sort=-created,title&" +
        "page[number]=2&page[size]=10&" +
        "include=author,comments&" +
        "fields[articles]=title,body&fields[people]=name"

      const params = QueryParams.parseQueryParams(url)

      expect(params).toEqual({
        filter: { status: "published", category: "tech" },
        sort: [
          { field: "created", direction: "desc" },
          { field: "title", direction: "asc" },
        ],
        page: { number: "2", size: "10" },
        include: ["author", "comments"],
        fields: {
          articles: ["title", "body"],
          people: ["name"],
        },
      })
    })
  })
})
