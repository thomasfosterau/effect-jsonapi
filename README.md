# effect-jsonapi

A library for defining and implementing JSON:API compliant APIs in Effect.

[![npm version](https://badge.fury.io/js/effect-jsonapi.svg)](https://www.npmjs.com/package/effect-jsonapi)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- 🔥 Built on top of [Effect](https://effect.website/) for type-safe, composable, and functional programming
- 📝 Full JSON:API v1.1 specification compliance
- 🎯 Type-safe schema definitions using Effect Schema
- 🔗 HTTP integration with `@effect/platform`
- 🔍 Query parameter parsing (filter, sort, pagination, includes)
- 🛠️ Builder utilities for constructing responses
- 📦 Serialization helpers for converting data to JSON:API format
- ⚡ Minimal dependencies

## Installation

```bash
npm install effect-jsonapi effect @effect/platform
```

## Quick Start

### Creating a Resource

```typescript
import * as JsonApi from "effect-jsonapi"

// Create a resource object
const article = JsonApi.resource(
  "articles",
  "1",
  {
    title: "JSON:API with Effect",
    body: "Learn how to build APIs with Effect and JSON:API",
  },
  {
    relationships: {
      author: JsonApi.toOneRelationship(
        JsonApi.resourceIdentifier("people", "9")
      ),
    },
  }
)
```

### Building a Response

```typescript
import * as JsonApi from "effect-jsonapi"
import { Effect } from "effect"

// Create a success response with a single resource
const response = JsonApi.successOne(article, {
  meta: { version: "1.0" },
})

// Or with Effect
const responseEffect = JsonApi.successOneEffect(article, {
  meta: { version: "1.0" },
})
```

### HTTP Integration

```typescript
import * as JsonApi from "effect-jsonapi"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"

// Create an HTTP response
const httpResponse = JsonApi.successOneResponse(article, {
  status: 200,
  meta: { version: "1.0" },
})

// Error responses
const notFound = JsonApi.notFoundResponse(
  "Article with id '123' not found"
)

const validationError = JsonApi.errorResponse([
  JsonApi.error({
    status: "422",
    title: "Validation Error",
    detail: "Title must be at least 3 characters",
    source: { pointer: "/data/attributes/title" },
  }),
])
```

### Parsing Query Parameters

```typescript
import * as JsonApi from "effect-jsonapi"

const url = "https://api.example.com/articles?filter[status]=published&sort=-created&page[number]=1&include=author,comments"

const params = JsonApi.parseQueryParams(url)
// {
//   filter: { status: 'published' },
//   sort: [{ field: 'created', direction: 'desc' }],
//   page: { number: '1' },
//   include: ['author', 'comments']
// }
```

### Serialization

```typescript
import * as JsonApi from "effect-jsonapi"

interface Article {
  id: string
  title: string
  body: string
  authorId: string
}

// Create a serializer
const articleSerializer = JsonApi.createSerializer<Article>({
  type: "articles",
  getId: (article) => article.id,
  getAttributes: (article) => ({
    title: article.title,
    body: article.body,
  }),
  getRelationships: (article) => ({
    author: JsonApi.toOneRelationship(
      JsonApi.resourceIdentifier("people", article.authorId)
    ),
  }),
})

const article = {
  id: "1",
  title: "Hello World",
  body: "This is my first article",
  authorId: "42",
}

const resourceObject = articleSerializer.serialize(article)
```

## API Documentation

### Schema Types

The library exports the following JSON:API schema types:

- `Document` - Top-level JSON:API document
- `ResourceObject` - A resource with type, id, attributes, and relationships
- `ResourceIdentifier` - Reference to a resource (type + id)
- `Relationship` - Relationship to other resources
- `ErrorObject` - JSON:API error object
- `Links` - Navigation links
- `JsonApiObject` - JSON:API version information

### Builder Functions

#### Resource Building

- `resource(type, id, attributes?, options?)` - Create a resource object
- `resourceIdentifier(type, id, meta?)` - Create a resource identifier
- `toOneRelationship(data, options?)` - Create a to-one relationship
- `toManyRelationship(data, options?)` - Create a to-many relationship

#### Document Building

- `successOne(resource, options?)` - Create a success document with single resource
- `successMany(resources, options?)` - Create a success document with multiple resources
- `error(options)` - Create an error object
- `errorDocument(errors, options?)` - Create an error document

#### Effect Builders

- `successOneEffect(resource, options?)` - Effect version of successOne
- `successManyEffect(resources, options?)` - Effect version of successMany
- `errorEffect(errors, options?)` - Effect version of errorDocument

### HTTP Functions

- `jsonApiResponse(document, status?)` - Create HTTP response with JSON:API headers
- `successOneResponse(resource, options?)` - HTTP response for single resource
- `successManyResponse(resources, options?)` - HTTP response for multiple resources
- `errorResponse(errors, options?)` - HTTP error response
- `notFoundResponse(detail?)` - 404 error response
- `badRequestResponse(detail, source?)` - 400 error response
- `unprocessableEntityResponse(errors)` - 422 error response
- `validateContentType(request)` - Validate Content-Type header
- `validateAccept(request)` - Validate Accept header
- `parseDocument(request)` - Parse and validate request body

### Query Parameter Parsing

- `parseQueryParams(url)` - Parse all query parameters
- `parseFilter(searchParams)` - Parse filter parameters
- `parseSort(sortParam)` - Parse sort parameter
- `parsePage(searchParams)` - Parse pagination parameters
- `parseInclude(includeParam)` - Parse include parameter
- `parseFields(searchParams)` - Parse sparse fieldsets

### Serialization

- `serialize(config, data)` - Serialize data to resource object
- `serializeMany(config, data)` - Serialize array to resource objects
- `createSerializer(config)` - Create a reusable serializer
- `createSimpleSerializer(type, getAttributes?)` - Create simple serializer for id-based entities

## Example: Complete API Endpoint

```typescript
import * as Effect from "effect/Effect"
import * as JsonApi from "effect-jsonapi"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"

interface Article {
  id: string
  title: string
  body: string
}

const articleSerializer = JsonApi.createSimpleSerializer<Article>(
  "articles",
  (article) => ({
    title: article.title,
    body: article.body,
  })
)

const getArticles = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    // Parse query parameters
    const url = request.url
    const params = JsonApi.parseQueryParams(url)
    
    // Fetch articles (mock data)
    const articles: Article[] = [
      { id: "1", title: "First Article", body: "Content 1" },
      { id: "2", title: "Second Article", body: "Content 2" },
    ]
    
    // Serialize to JSON:API
    const resources = articleSerializer.serializeMany(articles)
    
    // Create response
    return yield* JsonApi.successManyResponse(resources, {
      meta: { total: articles.length },
    })
  })
```

## Specification Compliance

This library implements the [JSON:API v1.1 specification](https://jsonapi.org/format/1.1/):

- ✅ Document structure (data, errors, meta, links, included)
- ✅ Resource objects (type, id, attributes, relationships)
- ✅ Resource identifier objects
- ✅ Relationship objects
- ✅ Error objects with source pointers
- ✅ Links objects
- ✅ Query parameters (filter, sort, page, include, fields)
- ✅ Content negotiation (`application/vnd.api+json`)
- ✅ HTTP status codes

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © Thomas Foster

## Links

- [JSON:API Specification](https://jsonapi.org/)
- [Effect Documentation](https://effect.website/)
- [GitHub Repository](https://github.com/thomasfosterau/effect-jsonapi)

