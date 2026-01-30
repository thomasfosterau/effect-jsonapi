/**
 * Example: Building a simple blog API with effect-jsonapi
 * 
 * This example demonstrates how to create a JSON:API compliant blog API
 * using effect-jsonapi and @effect/platform
 */

import * as Effect from "effect/Effect"
import * as JsonApi from "../src/index"

// Define your data models
interface Article {
  id: string
  title: string
  body: string
  createdAt: string
  authorId: string
}

interface Author {
  id: string
  name: string
  email: string
}

// Mock database
const articles: Article[] = [
  {
    id: "1",
    title: "Getting Started with Effect",
    body: "Effect is a powerful library for building type-safe applications...",
    createdAt: "2024-01-01T00:00:00Z",
    authorId: "1",
  },
  {
    id: "2",
    title: "JSON:API Best Practices",
    body: "Learn how to design and implement JSON:API compliant APIs...",
    createdAt: "2024-01-02T00:00:00Z",
    authorId: "2",
  },
]

const authors: Author[] = [
  {
    id: "1",
    name: "Alice Johnson",
    email: "alice@example.com",
  },
  {
    id: "2",
    name: "Bob Smith",
    email: "bob@example.com",
  },
]

// Create serializers
const articleSerializer = JsonApi.createSerializer<Article>({
  type: "articles",
  getId: (article) => article.id,
  getAttributes: (article) => ({
    title: article.title,
    body: article.body,
    createdAt: article.createdAt,
  }),
  getRelationships: (article) => ({
    author: JsonApi.toOneRelationship(
      JsonApi.resourceIdentifier("authors", article.authorId)
    ),
  }),
  getLinks: (article) => ({
    self: `/articles/${article.id}`,
  }),
})

const authorSerializer = JsonApi.createSimpleSerializer<Author>(
  "authors",
  (author) => ({
    name: author.name,
    email: author.email,
  })
)

// Example 1: Get all articles
const getAllArticles = () =>
  Effect.gen(function* () {
    console.log("\n=== Example 1: Get All Articles ===\n")

    const resources = articleSerializer.serializeMany(articles)
    const document = JsonApi.successMany(resources, {
      meta: {
        total: articles.length,
      },
      links: {
        self: "/articles",
      },
    })

    console.log("Response:", JSON.stringify(document, null, 2))
    return document
  })

// Example 2: Get a single article with included author
const getArticleWithAuthor = (articleId: string) =>
  Effect.gen(function* () {
    console.log(`\n=== Example 2: Get Article ${articleId} with Author ===\n`)

    const article = articles.find((a) => a.id === articleId)
    if (!article) {
      const notFound = JsonApi.errorDocument([
        JsonApi.error({
          status: "404",
          title: "Not Found",
          detail: `Article with id '${articleId}' not found`,
        }),
      ])
      console.log("Response:", JSON.stringify(notFound, null, 2))
      return notFound
    }

    const author = authors.find((a) => a.id === article.authorId)
    const articleResource = articleSerializer.serialize(article)
    const included = author ? [authorSerializer.serialize(author)] : []

    const document = JsonApi.successOne(articleResource, {
      included,
      links: {
        self: `/articles/${articleId}`,
      },
    })

    console.log("Response:", JSON.stringify(document, null, 2))
    return document
  })

// Example 3: Handle filtering and sorting
const getFilteredArticles = (url: string) =>
  Effect.gen(function* () {
    console.log(`\n=== Example 3: Filtered Articles ===\n`)
    console.log(`URL: ${url}\n`)

    const params = JsonApi.parseQueryParams(url)
    console.log("Parsed params:", JSON.stringify(params, null, 2))

    // Apply filters
    let filteredArticles = articles
    if (params.filter?.authorId) {
      filteredArticles = filteredArticles.filter(
        (a) => a.authorId === params.filter?.authorId
      )
    }

    // Apply sorting
    if (params.sort && params.sort.length > 0) {
      const sortField = params.sort[0]
      filteredArticles = [...filteredArticles].sort((a, b) => {
        const aVal = a[sortField.field as keyof Article] as string
        const bVal = b[sortField.field as keyof Article] as string
        const comparison = aVal.localeCompare(bVal)
        return sortField.direction === "desc" ? -comparison : comparison
      })
    }

    // Apply pagination
    let page = 1
    let pageSize = 10
    if (params.page?.number) page = parseInt(params.page.number)
    if (params.page?.size) pageSize = parseInt(params.page.size)

    const start = (page - 1) * pageSize
    const paginatedArticles = filteredArticles.slice(start, start + pageSize)

    // Serialize
    const resources = articleSerializer.serializeMany(paginatedArticles)
    const document = JsonApi.successMany(resources, {
      meta: {
        total: filteredArticles.length,
        page: {
          number: page,
          size: pageSize,
        },
      },
      links: {
        self: url,
      },
    })

    console.log("\nResponse:", JSON.stringify(document, null, 2))
    return document
  })

// Example 4: Create a new article (validation error)
const createArticle = () =>
  Effect.gen(function* () {
    console.log("\n=== Example 4: Create Article (Validation Error) ===\n")

    // Simulate validation errors
    const errorDoc = JsonApi.errorDocument([
      JsonApi.error({
        status: "422",
        title: "Validation Error",
        detail: "Title must be at least 3 characters long",
        source: {
          pointer: "/data/attributes/title",
        },
      }),
      JsonApi.error({
        status: "422",
        title: "Validation Error",
        detail: "Body is required",
        source: {
          pointer: "/data/attributes/body",
        },
      }),
    ])

    console.log("Response:", JSON.stringify(errorDoc, null, 2))
    return errorDoc
  })

// Run all examples
const runExamples = Effect.gen(function* () {
  yield* getAllArticles()
  yield* getArticleWithAuthor("1")
  yield* getArticleWithAuthor("999") // Not found
  yield* getFilteredArticles(
    "https://api.example.com/articles?filter[authorId]=1&sort=-createdAt&page[number]=1&page[size]=10&include=author"
  )
  yield* createArticle()
})

// Execute the examples
Effect.runPromise(runExamples).catch(console.error)
